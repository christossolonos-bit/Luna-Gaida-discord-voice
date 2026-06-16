import {
  ApplicationCommandOptionType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type Attachment,
  type ChatInputCommandInteraction,
  type Message,
  type VoiceState
} from 'discord.js';
import { joinVoiceChannel, getVoiceConnection, type DiscordGatewayAdapterCreator } from '@discordjs/voice';
import { createPublicKey, verify } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../../config/env.js';
import type { MemoryRepository } from '../../memory/repository.js';
import type { PersonalityService } from '../../personality/service.js';
import { assertDiscordSafe, sanitizeForDiscord } from '../../policy/privacy.js';
import type { GiadaPlugin } from '../plugin.js';
import { logger } from '../../logging/logger.js';
import { DiscordSettingsStore } from './settings.js';
import {
  DiscordTextResponder,
  type DiscordAttachmentSummary,
  type DiscordContextMessage,
  type DiscordImageAttachment
} from './responder.js';
import { DiscordVoiceBridge } from './voiceBridge.js';

const MAX_DISCORD_IMAGE_ATTACHMENTS = 4;
const MAX_DISCORD_IMAGE_BYTES = 8 * 1024 * 1024;

const giadaCommand = new SlashCommandBuilder()
  .setName('giada')
  .setDescription('Control Giada companion settings.')
  .addSubcommand((subcommand) => subcommand
    .setName('help')
    .setDescription('Show Giada Discord commands.'))
  .addSubcommand((subcommand) => subcommand
    .setName('status')
    .setDescription('Show current Discord companion settings.'))
  .addSubcommand((subcommand) => subcommand
    .setName('listen')
    .setDescription('Set or disable the always-listen text channel.')
    .addStringOption((option) => option
      .setName('mode')
      .setDescription('Use here to reply to every message, or off to require her name/mention.')
      .setRequired(true)
      .addChoices(
        { name: 'here', value: 'here' },
        { name: 'off', value: 'off' }
      ))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Text channel to use. Defaults to the current channel.')
      .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.PrivateThread)
      .setRequired(false)))
  .addSubcommand((subcommand) => subcommand
    .setName('voice')
    .setDescription('Join voice or configure voice-channel watching.')
    .addStringOption((option) => option
      .setName('mode')
      .setDescription('watch joins when people enter; off disables watching; join joins now.')
      .setRequired(true)
      .addChoices(
        { name: 'watch', value: 'watch' },
        { name: 'off', value: 'off' },
        { name: 'join', value: 'join' }
      ))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Voice channel. Defaults to your current voice channel.')
      .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
      .setRequired(false)));

type DiscordRegisteredCommand = {
  id: string;
  name: string;
  application_id: string;
};

const InteractionType = {
  Ping: 1,
  ApplicationCommand: 2
} as const;

const InteractionResponseType = {
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5
} as const;

interface DiscordHttpOption {
  name: string;
  type: number;
  value?: string | number | boolean;
  options?: DiscordHttpOption[];
}

interface DiscordHttpInteraction {
  id: string;
  type: number;
  token: string;
  application_id: string;
  guild_id?: string;
  channel_id?: string;
  data?: {
    name?: string;
    options?: DiscordHttpOption[];
  };
  member?: {
    user?: { id: string; username?: string };
    nick?: string | null;
    permissions?: string;
  };
  user?: { id: string; username?: string };
}

export class DiscordPlugin implements GiadaPlugin {
  readonly name = 'discord';
  private client: Client | null = null;
  private readonly settings: DiscordSettingsStore;
  private readonly responder: DiscordTextResponder;
  private readonly voiceBridges = new Map<string, DiscordVoiceBridge>();

  constructor(
    private readonly config: AppConfig,
    private readonly memory: MemoryRepository,
    private readonly personality: PersonalityService
  ) {
    this.settings = new DiscordSettingsStore(config.databasePath);
    this.responder = new DiscordTextResponder(config, memory, personality);
  }

  async start() {
    if (!isUsableDiscordToken(this.config.DISCORD_BOT_TOKEN)) {
      logger.info('Discord plugin disabled: DISCORD_BOT_TOKEN not configured');
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
      ],
      partials: [Partials.Channel]
    });

    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message);
    });
    this.client.on('raw', (packet: { t?: string; d?: { id?: string; type?: number; data?: { name?: string }; guild_id?: string } }) => {
      if (packet.t === 'INTERACTION_CREATE') {
        logger.info('Received raw Discord INTERACTION_CREATE packet', {
          id: packet.d?.id,
          type: packet.d?.type,
          command: packet.d?.data?.name ?? null,
          guildId: packet.d?.guild_id ?? null
        });
      }
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand()) {
        void this.handleInteraction(interaction).catch((error) => {
          logger.error('Discord slash command handler failed', {
            command: interaction.commandName,
            id: interaction.id,
            guildId: interaction.guildId,
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }
    });
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      void this.handleVoiceStateUpdate(oldState, newState);
    });
    this.client.once(Events.ClientReady, () => {
      const configuredApplicationId = this.config.DISCORD_APPLICATION_ID?.trim();
      const activeApplicationId = this.client?.application?.id ?? this.client?.user?.id;
      logger.info('Discord bot ready', {
        user: this.client?.user?.tag,
        userId: this.client?.user?.id,
        activeApplicationId,
        configuredApplicationId: configuredApplicationId ?? null,
        guilds: this.client?.guilds.cache.size ?? 0
      });
      if (configuredApplicationId && activeApplicationId && configuredApplicationId !== activeApplicationId) {
        logger.error('DISCORD_APPLICATION_ID does not match the logged-in bot application. Slash commands registered to the configured application will not reach this process.', {
          configuredApplicationId,
          activeApplicationId,
          botUserId: this.client?.user?.id
        });
      }
      void this.registerCommands();
      void this.restoreWatchedVoiceConnections();
    });
    this.client.on(Events.GuildCreate, () => {
      void this.registerCommands();
    });

    try {
      await this.client.login(this.config.DISCORD_BOT_TOKEN);
      logger.info('Discord plugin started');
    } catch (error) {
      this.client.destroy();
      this.client = null;
      logger.error('Discord plugin disabled: login failed. Check DISCORD_BOT_TOKEN.', error instanceof Error ? error.message : String(error));
    }
  }

  async stop() {
    for (const bridge of this.voiceBridges.values()) {
      bridge.destroy();
    }
    this.voiceBridges.clear();
    for (const guild of this.client?.guilds.cache.values() ?? []) {
      getVoiceConnection(guild.id)?.destroy();
    }
    await this.client?.destroy();
    this.client = null;
  }

  getStatus() {
    const applicationId = this.config.DISCORD_APPLICATION_ID?.trim() || this.client?.application?.id || this.client?.user?.id || null;
    return {
      configured: {
        usableToken: isUsableDiscordToken(this.config.DISCORD_BOT_TOKEN),
        applicationId,
        bearerTokenConfigured: Boolean(this.config.DISCORD_BEARER_TOKEN?.trim()),
        publicKeyConfigured: Boolean(this.config.DISCORD_PUBLIC_KEY?.trim()),
        guildId: this.config.DISCORD_GUILD_ID ?? null,
        registerGlobalCommands: this.config.DISCORD_REGISTER_GLOBAL_COMMANDS,
        registrationMode: this.config.DISCORD_GUILD_ID
          ? 'single_guild_rest'
          : this.config.DISCORD_REGISTER_GLOBAL_COMMANDS
            ? 'cached_guilds_and_global_rest'
            : 'cached_guilds_rest'
      },
      connected: Boolean(this.client?.isReady()),
      user: this.client?.user
        ? { id: this.client.user.id, tag: this.client.user.tag }
        : null,
      readyAt: this.client?.readyAt?.toISOString() ?? null,
      guilds: [...(this.client?.guilds.cache.values() ?? [])].map((guild) => ({
        id: guild.id,
        name: guild.name
      }))
    };
  }

  async refreshCommands() {
    await this.registerCommands();
    return this.getStatus();
  }

  async handleHttpInteraction(req: IncomingMessage, res: ServerResponse) {
    const rawBody = await readRequestBody(req);
    if (!this.verifyHttpInteraction(req, rawBody)) {
      writeJson(res, 401, { error: 'Invalid Discord interaction signature' });
      return;
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as DiscordHttpInteraction;
    logger.info('Received Discord HTTP interaction', {
      id: payload.id,
      type: payload.type,
      command: payload.data?.name ?? null,
      guildId: payload.guild_id ?? null
    });

    if (payload.type === InteractionType.Ping) {
      writeJson(res, 200, { type: InteractionResponseType.Pong });
      return;
    }

    if (payload.type !== InteractionType.ApplicationCommand || payload.data?.name !== 'giada') {
      writeJson(res, 200, {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: 'Unsupported interaction.', allowed_mentions: { parse: [] } }
      });
      return;
    }

    writeJson(res, 200, { type: InteractionResponseType.DeferredChannelMessageWithSource });
    void this.handleHttpGiadaCommand(payload).catch(async (error) => {
      logger.error('Discord HTTP slash command failed', {
        id: payload.id,
        error: error instanceof Error ? error.message : String(error)
      });
      await this.updateHttpInteraction(payload, `Discord command error: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async handleMessage(message: Message) {
    if (message.author.bot || !message.guildId) {
      return;
    }

    const settings = this.settings.get(message.guildId);
    const addressed = this.isAddressed(message);
    const listeningChannel = settings.listeningChannelId === message.channelId;
    if (!listeningChannel && !addressed) {
      return;
    }

    const safeInput = assertDiscordSafe(message.content);
    if (!safeInput.ok) {
      await this.reply(message, safeInput.text);
      return;
    }

    this.memory.write({
      content: `Discord ${message.guildId}/${message.channelId} ${message.member?.displayName ?? message.author.username}: ${safeInput.text}`,
      source: 'discord',
      privacy: 'public',
      tags: ['discord', message.guildId, message.channelId]
    });

    if ('sendTyping' in message.channel && typeof message.channel.sendTyping === 'function') {
      await message.channel.sendTyping();
    }
    const context = await this.collectMessageContext(message);
    const response = await this.responder.reply({
      guildId: message.guildId,
      channelId: message.channelId,
      authorName: message.member?.displayName ?? message.author.username,
      text: safeInput.text,
      replyTo: context.replyTo,
      recentMessages: context.recentMessages,
      images: context.images
    });
    await this.reply(message, response);

    this.memory.write({
      content: `Discord ${message.guildId}/${message.channelId} ${this.personality.get().name}: ${response}`,
      source: 'discord',
      privacy: 'public',
      tags: ['discord', message.guildId, message.channelId, 'assistant']
    });
  }

  private async handleInteraction(interaction: ChatInputCommandInteraction) {
    if (interaction.commandName !== 'giada') {
      return;
    }

    logger.info('Received Discord slash command', {
      command: interaction.commandName,
      subcommand: interaction.options.getSubcommand(false) ?? null,
      id: interaction.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId
    });
    try {
      await interaction.deferReply();
      logger.info('Deferred Discord slash command', { id: interaction.id });
    } catch (error) {
      logger.error('Failed to defer Discord slash command', {
        id: interaction.id,
        error: error instanceof Error ? error.message : String(error)
      });
      return;
    }

    if (!interaction.guildId || !interaction.guild) {
      await this.replyInteraction(interaction, 'Giada server settings can only be used inside a Discord server.');
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'help') {
      await this.replyInteraction(interaction, this.helpText());
      return;
    }

    if (subcommand === 'status') {
      await this.replyInteraction(interaction, this.statusText(interaction.guildId));
      return;
    }

    if (subcommand === 'listen') {
      if (!(await this.requireManageGuild(interaction))) {
        return;
      }
      const mode = interaction.options.getString('mode', true);
      if (mode === 'off') {
        this.settings.setListeningChannel(interaction.guildId, null);
        await this.replyInteraction(interaction, 'Listening channel disabled. I will answer only when named or mentioned.');
        return;
      }
      const channelId = interaction.options.getChannel('channel')?.id ?? interaction.channelId;
      this.settings.setListeningChannel(interaction.guildId, channelId);
      await this.replyInteraction(interaction, `Listening channel set to <#${channelId}>. I will reply to every non-bot message there.`);
      return;
    }

    if (subcommand === 'voice') {
      const mode = interaction.options.getString('mode', true);
      if (mode === 'off') {
        if (!(await this.requireManageGuild(interaction))) {
          return;
        }
        const settings = this.settings.get(interaction.guildId);
        this.settings.setVoiceWatchChannel(interaction.guildId, null);
        this.destroyVoiceBridge(interaction.guildId);
        getVoiceConnection(interaction.guildId)?.destroy();
        await this.replyInteraction(interaction, `Voice watch disabled${settings.voiceWatchChannelId ? ` for <#${settings.voiceWatchChannelId}>` : ''}.`);
        return;
      }

      if (mode === 'watch' && !(await this.requireManageGuild(interaction))) {
        return;
      }

      const voiceChannelId = await this.resolveVoiceChannelId(interaction);
      if (!voiceChannelId) {
        await this.replyInteraction(interaction, 'Join a voice channel first, or choose a voice channel.');
        return;
      }

      if (mode === 'watch') {
        this.settings.setVoiceWatchChannel(interaction.guildId, voiceChannelId);
        await this.replyInteraction(interaction, `Voice watch set to <#${voiceChannelId}>. I will join when someone enters and leave after everyone leaves.`);
        await this.joinWatchedVoiceIfNeeded(interaction.guildId, voiceChannelId);
        return;
      }

      if (mode === 'join') {
        this.joinVoice(interaction.guildId, voiceChannelId);
        await this.replyInteraction(interaction, 'Joined voice. I will listen and reply with voice while connected.');
        return;
      }
    }

    await this.replyInteraction(interaction, 'Unknown `/giada` command.');
  }

  private async handleHttpGiadaCommand(payload: DiscordHttpInteraction) {
    if (!payload.guild_id) {
      await this.updateHttpInteraction(payload, 'Giada server settings can only be used inside a Discord server.');
      return;
    }

    const subcommand = getHttpSubcommand(payload);
    if (subcommand?.name === 'help') {
      await this.updateHttpInteraction(payload, this.helpText());
      return;
    }

    if (subcommand?.name === 'status') {
      await this.updateHttpInteraction(payload, this.statusText(payload.guild_id));
      return;
    }

    if (subcommand?.name === 'listen') {
      if (!this.hasHttpManageGuild(payload)) {
        await this.updateHttpInteraction(payload, 'You need Manage Server permission to change Discord companion settings.');
        return;
      }
      const mode = getHttpStringOption(subcommand, 'mode');
      if (mode === 'off') {
        this.settings.setListeningChannel(payload.guild_id, null);
        await this.updateHttpInteraction(payload, 'Listening channel disabled. I will answer only when named or mentioned.');
        return;
      }
      const channelId = getHttpStringOption(subcommand, 'channel') ?? payload.channel_id;
      if (!channelId) {
        await this.updateHttpInteraction(payload, 'Choose a text channel or run this command inside one.');
        return;
      }
      this.settings.setListeningChannel(payload.guild_id, channelId);
      await this.updateHttpInteraction(payload, `Listening channel set to <#${channelId}>. I will reply to every non-bot message there.`);
      return;
    }

    if (subcommand?.name === 'voice') {
      const mode = getHttpStringOption(subcommand, 'mode');
      if (mode === 'off') {
        if (!this.hasHttpManageGuild(payload)) {
          await this.updateHttpInteraction(payload, 'You need Manage Server permission to change Discord companion settings.');
          return;
        }
        const settings = this.settings.get(payload.guild_id);
        this.settings.setVoiceWatchChannel(payload.guild_id, null);
        this.destroyVoiceBridge(payload.guild_id);
        getVoiceConnection(payload.guild_id)?.destroy();
        await this.updateHttpInteraction(payload, `Voice watch disabled${settings.voiceWatchChannelId ? ` for <#${settings.voiceWatchChannelId}>` : ''}.`);
        return;
      }

      if (mode === 'watch' && !this.hasHttpManageGuild(payload)) {
        await this.updateHttpInteraction(payload, 'You need Manage Server permission to change Discord companion settings.');
        return;
      }

      const voiceChannelId = this.resolveHttpVoiceChannelId(payload, subcommand);
      if (!voiceChannelId) {
        await this.updateHttpInteraction(payload, 'Join a voice channel first, or choose a voice channel.');
        return;
      }

      if (mode === 'watch') {
        this.settings.setVoiceWatchChannel(payload.guild_id, voiceChannelId);
        await this.updateHttpInteraction(payload, `Voice watch set to <#${voiceChannelId}>. I will join when someone enters and leave after everyone leaves.`);
        await this.joinWatchedVoiceIfNeeded(payload.guild_id, voiceChannelId);
        return;
      }

      if (mode === 'join') {
        this.joinVoice(payload.guild_id, voiceChannelId);
        await this.updateHttpInteraction(payload, 'Joined voice. I will listen and reply with voice while connected.');
        return;
      }
    }

    await this.updateHttpInteraction(payload, 'Unknown `/giada` command.');
  }

  private async registerCommands() {
    const client = this.client;
    if (!client) {
      return;
    }

    const configuredApplicationId = this.config.DISCORD_APPLICATION_ID?.trim();
    const activeApplicationId = client.application?.id || client.user?.id;
    if (configuredApplicationId && activeApplicationId && configuredApplicationId !== activeApplicationId) {
      logger.error('Refusing to register slash commands to a different application than the logged-in bot.', {
        configuredApplicationId,
        activeApplicationId,
        botUserId: client.user?.id
      });
      return;
    }

    const applicationId = activeApplicationId ?? configuredApplicationId;
    const registrationToken = this.discordRegistrationToken();
    if (!applicationId || !registrationToken) {
      logger.error('Cannot register Discord commands: missing DISCORD_APPLICATION_ID or Discord authorization token');
      return;
    }

    const rest = new REST({ version: '10' }).setToken(registrationToken);
    const commands = [giadaCommand.toJSON()];
    const guildIds = this.config.DISCORD_GUILD_ID
      ? [this.config.DISCORD_GUILD_ID]
      : [...client.guilds.cache.keys()];

    for (const guildId of guildIds) {
      try {
        const registered = await rest.put(
          Routes.applicationGuildCommands(applicationId, guildId),
          { body: commands }
        ) as DiscordRegisteredCommand[];
        logger.info('Registered Discord slash commands with REST route', {
          applicationId,
          guildId,
          commands: registered.map((command) => ({ id: command.id, name: command.name }))
        });
      } catch (error) {
        logger.error('Failed to register Discord slash commands', {
          applicationId,
          guildId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (this.config.DISCORD_REGISTER_GLOBAL_COMMANDS) {
      try {
        const registered = await rest.put(
          Routes.applicationCommands(applicationId),
          { body: commands }
        ) as DiscordRegisteredCommand[];
        logger.info('Registered global Discord slash commands with REST route', {
          applicationId,
          commands: registered.map((command) => ({ id: command.id, name: command.name }))
        });
      } catch (error) {
        logger.error('Failed to register global Discord slash commands', error instanceof Error ? error.message : String(error));
      }
    }
  }

  private discordRegistrationToken() {
    const botToken = this.config.DISCORD_BOT_TOKEN?.trim();
    if (botToken) {
      return botToken;
    }
    const bearerToken = this.config.DISCORD_BEARER_TOKEN?.trim();
    if (bearerToken) {
      return bearerToken;
    }
    return null;
  }

  private async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    const guildId = newState.guild.id;
    const settings = this.settings.get(guildId);
    if (!settings.voiceWatchChannelId) {
      return;
    }

    const watchedChannelId = settings.voiceWatchChannelId;
    const botUserId = this.client?.user?.id;
    const isBotVoiceState = Boolean(botUserId && oldState.id === botUserId);
    if (isBotVoiceState && oldState.channelId === watchedChannelId && newState.channelId !== watchedChannelId) {
      setTimeout(() => {
        void this.joinWatchedVoiceIfNeeded(guildId, watchedChannelId);
      }, 1000);
      return;
    }

    if (newState.channelId === watchedChannelId) {
      await this.joinWatchedVoiceIfNeeded(guildId, watchedChannelId);
      return;
    }

    if (oldState.channelId === watchedChannelId || newState.channelId === watchedChannelId) {
      setTimeout(() => {
        this.leaveWatchedVoiceIfEmpty(guildId, watchedChannelId);
      }, 1000);
    }
  }

  private async joinWatchedVoiceIfNeeded(guildId: string, channelId: string) {
    const humanMembers = this.countHumanVoiceMembers(guildId, channelId);
    if (humanMembers <= 0) {
      return;
    }
    this.joinVoice(guildId, channelId);
  }

  private leaveWatchedVoiceIfEmpty(guildId: string, channelId: string) {
    const humanMembers = this.countHumanVoiceMembers(guildId, channelId);
    if (humanMembers > 0) {
      return;
    }
    const connection = getVoiceConnection(guildId);
    if (connection?.joinConfig.channelId !== channelId) {
      return;
    }
    this.destroyVoiceBridge(guildId);
    connection.destroy();
  }

  private joinVoice(guildId: string, channelId: string) {
    const guild = this.client?.guilds.cache.get(guildId);
    if (!guild) {
      logger.warn('Cannot join Discord voice channel because guild is not cached', { guildId, channelId });
      return;
    }
    const botUserId = this.client?.user?.id;
    if (!botUserId) {
      logger.warn('Cannot join Discord voice channel because bot user is not ready', { guildId, channelId });
      return;
    }
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator,
      selfDeaf: false,
      selfMute: false
    });
    this.getVoiceBridge(guildId, botUserId).attach(connection, channelId);
    this.unsuppressStageVoiceIfNeeded(guildId, channelId);
  }

  private countHumanVoiceMembers(guildId: string, channelId: string) {
    const guild = this.client?.guilds.cache.get(guildId);
    if (!guild) {
      return 0;
    }
    const channel = guild.channels.cache.get(channelId);
    if (channel?.isVoiceBased()) {
      return channel.members.filter((member) => !member.user.bot).size;
    }
    return guild.voiceStates.cache.filter((state) => state.channelId === channelId && !state.member?.user.bot).size;
  }

  private async restoreWatchedVoiceConnections() {
    for (const guild of this.client?.guilds.cache.values() ?? []) {
      const channelId = this.settings.get(guild.id).voiceWatchChannelId;
      if (channelId) {
        await this.joinWatchedVoiceIfNeeded(guild.id, channelId);
      }
    }
  }

  private getVoiceBridge(guildId: string, botUserId: string) {
    let bridge = this.voiceBridges.get(guildId);
    if (!bridge) {
      bridge = new DiscordVoiceBridge(
        guildId,
        botUserId,
        (userId) => this.resolveVoiceSpeakerName(guildId, userId),
        this.config,
        this.memory,
        this.personality
      );
      this.voiceBridges.set(guildId, bridge);
    }
    return bridge;
  }

  private resolveVoiceSpeakerName(guildId: string, userId: string) {
    const guild = this.client?.guilds.cache.get(guildId);
    const voiceMember = guild?.voiceStates.cache.get(userId)?.member;
    const guildMember = guild?.members.cache.get(userId);
    const cachedUser = this.client?.users.cache.get(userId);
    return voiceMember?.displayName
      ?? guildMember?.displayName
      ?? cachedUser?.globalName
      ?? cachedUser?.username
      ?? `Discord user ${userId}`;
  }

  private destroyVoiceBridge(guildId: string) {
    const bridge = this.voiceBridges.get(guildId);
    if (!bridge) {
      return;
    }
    bridge.destroy();
    this.voiceBridges.delete(guildId);
  }

  private unsuppressStageVoiceIfNeeded(guildId: string, channelId: string) {
    const guild = this.client?.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (channel?.type !== ChannelType.GuildStageVoice) {
      return;
    }

    setTimeout(() => {
      void guild?.members.me?.voice.setSuppressed(false).catch((error) => {
        logger.warn('Could not unsuppress Discord stage voice state', {
          guildId,
          channelId,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, 1000);
  }

  private isAddressed(message: Message) {
    const botUser = this.client?.user;
    const name = this.personality.get().name.toLowerCase();
    return Boolean(botUser && message.mentions.has(botUser)) || message.content.toLowerCase().includes(name);
  }

  private async collectMessageContext(message: Message): Promise<{ replyTo: DiscordContextMessage | null; recentMessages: DiscordContextMessage[]; images: DiscordImageAttachment[] }> {
    const images: DiscordImageAttachment[] = [];
    const recentMessagesPromise = this.fetchRecentMessages(message);
    const replyTo = await this.fetchReplyTarget(message, images);
    const currentAttachments = await this.collectAttachmentSummaries(message, 'current message', images);
    const recentMessages = await recentMessagesPromise;
    const currentMessage = this.formatContextMessage(message, currentAttachments);
    return {
      replyTo,
      recentMessages: [
        ...recentMessages.filter((candidate) => candidate.timestamp !== currentMessage.timestamp),
        currentMessage
      ].slice(-11),
      images
    };
  }

  private async fetchReplyTarget(message: Message, images: DiscordImageAttachment[] = []): Promise<DiscordContextMessage | null> {
    if (!message.reference?.messageId) {
      return null;
    }
    const referenced = await message.fetchReference().catch(() => null);
    if (!referenced || referenced.id === message.id) {
      return null;
    }
    const attachments = await this.collectAttachmentSummaries(referenced, 'replied-to message', images);
    return this.formatContextMessage(referenced, attachments);
  }

  private async fetchRecentMessages(message: Message): Promise<DiscordContextMessage[]> {
    if (!('messages' in message.channel)) {
      return [];
    }

    const fetched = await message.channel.messages.fetch({ limit: 12, before: message.id }).catch(() => null);
    if (!fetched) {
      return [];
    }

    return [...fetched.values()]
      .filter((candidate) => candidate.id !== message.id)
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .slice(-10)
      .map((candidate) => this.formatContextMessage(candidate, this.summarizeAttachments(candidate)));
  }

  private async collectAttachmentSummaries(message: Message, scope: string, images: DiscordImageAttachment[]) {
    const summaries = this.summarizeAttachments(message);
    const attachments = [...message.attachments.values()];
    for (let index = 0; index < attachments.length; index += 1) {
      const attachment = attachments[index];
      const summary = summaries[index];
      if (!attachment || !summary || !isSupportedDiscordImage(attachment)) {
        continue;
      }
      if (images.length >= MAX_DISCORD_IMAGE_ATTACHMENTS) {
        summary.skippedReason = 'image skipped: image limit reached';
        continue;
      }
      if (attachment.size > MAX_DISCORD_IMAGE_BYTES) {
        summary.skippedReason = 'image skipped: too large';
        continue;
      }
      const image = await this.downloadImageAttachment(attachment, `${scope} ${attachment.name ?? attachment.id}`);
      if (!image) {
        summary.skippedReason = 'image skipped: download failed';
        continue;
      }
      summary.imageIncluded = true;
      images.push(image);
    }
    return summaries;
  }

  private summarizeAttachments(message: Message): DiscordAttachmentSummary[] {
    return [...message.attachments.values()].slice(0, 8).map((attachment) => {
      const summary: DiscordAttachmentSummary = {
        name: attachment.name ?? attachment.id,
        contentType: attachment.contentType,
        size: attachment.size
      };
      if (!isSupportedDiscordImage(attachment)) {
        summary.skippedReason = 'metadata only';
      }
      return summary;
    });
  }

  private async downloadImageAttachment(attachment: Attachment, label: string): Promise<DiscordImageAttachment | null> {
    const mimeType = normalizeDiscordImageMimeType(attachment.contentType, attachment.name ?? attachment.url);
    if (!mimeType) {
      return null;
    }
    const response = await fetch(attachment.url).catch(() => null);
    if (!response?.ok) {
      return null;
    }
    const contentLength = Number(response.headers.get('content-length') ?? attachment.size);
    if (Number.isFinite(contentLength) && contentLength > MAX_DISCORD_IMAGE_BYTES) {
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DISCORD_IMAGE_BYTES) {
      return null;
    }
    return {
      label,
      mimeType,
      data: bytes.toString('base64')
    };
  }

  private formatContextMessage(message: Message, attachments: DiscordAttachmentSummary[] = this.summarizeAttachments(message)): DiscordContextMessage {
    const content = sanitizeForDiscord(message.cleanContent || message.content || '[no text]').trim();

    return {
      authorName: message.member?.displayName ?? message.author.username,
      content: clampContextText(content),
      timestamp: message.createdAt.toISOString(),
      attachments
    };
  }

  private async requireManageGuild(interaction: ChatInputCommandInteraction) {
    if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      return true;
    }
    await this.replyInteraction(interaction, 'You need Manage Server permission to change Discord companion settings.');
    return false;
  }

  private async reply(message: Message, content: string) {
    await message.reply({
      content,
      allowedMentions: { parse: [] }
    });
  }

  private async replyInteraction(interaction: ChatInputCommandInteraction, content: string) {
    const payload = {
      content,
      allowedMentions: { parse: [] }
    };
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply(payload);
      return;
    }
    if (interaction.replied) {
      await interaction.followUp(payload);
      return;
    }
    await interaction.reply(payload);
  }

  private helpText() {
    return [
      '`/giada listen mode:here` - reply to every message in this text channel.',
      '`/giada listen mode:off` - only reply when named or mentioned.',
      '`/giada voice mode:watch` - watch your current voice channel and auto-join when people enter.',
      '`/giada voice mode:off` - disable voice watching.',
      '`/giada voice mode:join` - join your current voice channel now.',
      '`/giada status` - show current Discord settings.'
    ].join('\n');
  }

  private statusText(guildId: string) {
    const settings = this.settings.get(guildId);
    return [
      `Listening channel: ${settings.listeningChannelId ? `<#${settings.listeningChannelId}>` : 'off'}`,
      `Voice watch channel: ${settings.voiceWatchChannelId ? `<#${settings.voiceWatchChannelId}>` : 'off'}`
    ].join('\n');
  }

  private async resolveVoiceChannelId(interaction: ChatInputCommandInteraction) {
    const selected = interaction.options.getChannel('channel');
    if (selected?.type === ChannelType.GuildVoice || selected?.type === ChannelType.GuildStageVoice) {
      return selected.id;
    }
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    return member?.voice.channelId ?? null;
  }

  private resolveHttpVoiceChannelId(payload: DiscordHttpInteraction, subcommand: DiscordHttpOption) {
    const selected = getHttpStringOption(subcommand, 'channel');
    if (selected) {
      return selected;
    }
    const guildId = payload.guild_id;
    const userId = payload.member?.user?.id ?? payload.user?.id;
    if (!guildId || !userId) {
      return null;
    }
    const guild = this.client?.guilds.cache.get(guildId);
    return guild?.voiceStates.cache.get(userId)?.channelId ?? null;
  }

  private hasHttpManageGuild(payload: DiscordHttpInteraction) {
    const permissions = payload.member?.permissions;
    if (!permissions) {
      return false;
    }
    try {
      return (BigInt(permissions) & PermissionFlagsBits.ManageGuild) === PermissionFlagsBits.ManageGuild;
    } catch {
      return false;
    }
  }

  private verifyHttpInteraction(req: IncomingMessage, rawBody: Buffer) {
    const publicKey = this.config.DISCORD_PUBLIC_KEY?.trim();
    if (!publicKey) {
      logger.error('Discord HTTP interaction rejected: DISCORD_PUBLIC_KEY is not configured');
      return false;
    }
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    if (typeof signature !== 'string' || typeof timestamp !== 'string') {
      return false;
    }
    try {
      const key = createPublicKey({
        key: Buffer.concat([
          Buffer.from('302a300506032b6570032100', 'hex'),
          Buffer.from(publicKey, 'hex')
        ]),
        format: 'der',
        type: 'spki'
      });
      return verify(null, Buffer.concat([Buffer.from(timestamp), rawBody]), key, Buffer.from(signature, 'hex'));
    } catch (error) {
      logger.error('Discord HTTP interaction signature verification failed', error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  private async updateHttpInteraction(payload: DiscordHttpInteraction, content: string) {
    const response = await fetch(`https://discord.com/api/v10/webhooks/${payload.application_id}/${payload.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] }
      })
    });
    if (!response.ok) {
      logger.error('Failed to update Discord HTTP interaction', {
        id: payload.id,
        status: response.status,
        body: await response.text().catch(() => '')
      });
    }
  }
}

function getHttpSubcommand(payload: DiscordHttpInteraction) {
  return payload.data?.options?.find((option) => option.type === ApplicationCommandOptionType.Subcommand);
}

function getHttpStringOption(parent: DiscordHttpOption, name: string) {
  const value = parent.options?.find((option) => option.name === name)?.value;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isSupportedDiscordImage(attachment: Attachment) {
  return Boolean(normalizeDiscordImageMimeType(attachment.contentType, attachment.name ?? attachment.url));
}

function normalizeDiscordImageMimeType(contentType: string | null, nameOrUrl = '') {
  const normalized = contentType?.toLowerCase().split(';')[0]?.trim();
  if (normalized && ['image/jpeg', 'image/png', 'image/webp'].includes(normalized)) {
    return normalized;
  }
  const lowerName = nameOrUrl.toLowerCase();
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (lowerName.endsWith('.png')) {
    return 'image/png';
  }
  if (lowerName.endsWith('.webp')) {
    return 'image/webp';
  }
  return null;
}

function clampContextText(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 700 ? `${normalized.slice(0, 697)}...` : normalized;
}

async function readRequestBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function writeJson(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

export function isUsableDiscordToken(token: string | undefined) {
  if (!token) {
    return false;
  }
  const trimmed = token.trim();
  if (!trimmed || trimmed === 'your_token_here' || trimmed === '<redacted>' || trimmed.toLowerCase().includes('replace')) {
    return false;
  }
  return trimmed.split('.').length >= 3;
}
