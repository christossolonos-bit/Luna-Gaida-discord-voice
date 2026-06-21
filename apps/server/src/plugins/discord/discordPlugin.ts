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
import {
  VoiceConnectionStatus,
  joinVoiceChannel,
  getVoiceConnection,
  type DiscordGatewayAdapterCreator,
  type DiscordGatewayAdapterImplementerMethods,
  type DiscordGatewayAdapterLibraryMethods
} from '@discordjs/voice';
import { createPublicKey, verify } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppConfig } from '../../config/env.js';
import type { MemoryStore } from '../../memory/types.js';
import { buildPersonalityInstruction, type PersonalityInstructionProvider, type PersonalityService } from '../../personality/service.js';
import type { PlatformStore } from '../../platform/store.js';
import { personalityProfileForRuntime } from '../../platform/store.js';
import { assertDiscordSafe, sanitizeForDiscord } from '../../policy/privacy.js';
import type { GiadaPlugin } from '../plugin.js';
import { logger } from '../../logging/logger.js';
import { DiscordSettingsStore } from './settings.js';
import {
  DiscordTextResponder,
  type DiscordAttachmentSummary,
  type DiscordContextMessage,
  type DiscordImageAttachment,
  type DiscordReactionSummary
} from './responder.js';
import { DiscordVoiceBridge } from './voiceBridge.js';

const MAX_DISCORD_IMAGE_ATTACHMENTS = 4;
const MAX_DISCORD_IMAGE_BYTES = 8 * 1024 * 1024;
const VOICE_WATCH_RECONCILE_MS = 15_000;
const VOICE_READY_TIMEOUT_MS = 30_000;
const VOICE_REJOIN_DELAY_MS = 3_000;
const VOICE_TEXT_MESSAGE_DEDUPE_MS = 60_000;

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
    .setName('authorize')
    .setDescription('Authorize a user to run Giada Discord commands.')
    .addUserOption((option) => option
      .setName('user')
      .setDescription('User to authorize.')
      .setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName('deauthorize')
    .setDescription('Remove a user authorization for Giada Discord commands.')
    .addUserOption((option) => option
      .setName('user')
      .setDescription('User to deauthorize.')
      .setRequired(true)))
  .addSubcommand((subcommand) => subcommand
    .setName('listen')
    .setDescription('Add or remove an always-listen text channel.')
    .addStringOption((option) => option
      .setName('mode')
      .setDescription('Use here to let Giada observe this channel, or off to require her name/mention.')
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
    .setDescription('Join voice or configure watched voice channels.')
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

interface DiscordVoiceGatewayDiagnostics {
  voiceStateUpdates: number;
  voiceServerUpdates: number;
  adapterVoiceStateUpdates: number;
  adapterVoiceServerUpdates: number;
  lastVoiceStateUpdateAt: string | null;
  lastVoiceServerUpdateAt: string | null;
  lastAdapterVoiceStateUpdateAt: string | null;
  lastAdapterVoiceServerUpdateAt: string | null;
  lastBotVoiceChannelId: string | null;
  lastBotVoiceSessionId: string | null;
}

interface DiscordVoiceConnectionDiagnostics {
  stateChanges: number;
  lastStateChangeAt: string | null;
  lastOldStatus: string | null;
  lastNewStatus: string | null;
  lastReason: number | null;
  lastCloseCode: number | null;
  lastError: string | null;
  lastDebug: string | null;
}

interface ActiveVoiceAdapter {
  methods: DiscordGatewayAdapterLibraryMethods;
  lastVoiceStateKey: string | null;
  lastVoiceServerKey: string | null;
}

export class DiscordPlugin implements GiadaPlugin {
  readonly name = 'discord';
  private client: Client | null = null;
  private readonly settings: DiscordSettingsStore;
  private readonly responder: DiscordTextResponder;
  private readonly voiceBridges = new Map<string, DiscordVoiceBridge>();
  private voiceWatchReconcileInterval: ReturnType<typeof setInterval> | null = null;
  private readonly voiceReadyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly voiceRejoinTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly voiceReadyReconnectAttempts = new Map<string, number>();
  private readonly voiceTextMessageIds = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly voiceGatewayDiagnostics = new Map<string, DiscordVoiceGatewayDiagnostics>();
  private readonly voiceConnectionDiagnostics = new Map<string, DiscordVoiceConnectionDiagnostics>();
  private readonly diagnosedVoiceConnections = new WeakSet<ReturnType<typeof joinVoiceChannel>>();
  private readonly activeVoiceAdapters = new Map<string, ActiveVoiceAdapter>();
  private readonly appliedIdentitySignatures = new Map<string, string>();

  constructor(
    private readonly config: AppConfig,
    private readonly memory: MemoryStore,
    private readonly personality: PersonalityService,
    private readonly platform?: PlatformStore
  ) {
    this.settings = new DiscordSettingsStore(config.databasePath, platform ? (settings) => {
      void platform.getGuildRuntime(settings.guildId).then((runtime) => platform.updateGuildConfig(settings.guildId, {
        settings: {
          ...runtime.settings,
          listeningChannelIds: settings.listeningChannelIds,
          voiceWatchChannelIds: settings.voiceWatchChannelIds
        }
      }, 'discord-command')).catch((error) => logger.warn('Could not persist Discord channel settings to PostgreSQL', {
        guildId: settings.guildId,
        error: error instanceof Error ? error.message : String(error)
      }));
    } : undefined);
    this.responder = new DiscordTextResponder(
      config,
      memory,
      personality,
      (guildId, channelId) => this.getMusicControllerForChannel(guildId, channelId),
      platform
    );
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
      void this.handleMessage(message).catch((error) => {
        logger.error('Discord message handler failed', {
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error)
        });
        if (message.guildId && message.author.id !== this.client?.user?.id) {
          if (isDiscordSendFailure(error)) {
            return;
          }
          void this.reply(message, 'I saw your message, but my reply generator failed. Check the backend logs for the exact error.').catch((replyError) => {
            logger.warn('Failed to send Discord message handler fallback', {
              guildId: message.guildId,
              channelId: message.channelId,
              messageId: message.id,
              error: replyError instanceof Error ? replyError.message : String(replyError)
            });
          });
        }
      });
    });
    this.client.on('raw', (packet: { t?: string; d?: { id?: string; type?: number; data?: { name?: string }; guild_id?: string; user_id?: string; channel_id?: string | null; session_id?: string | null } }) => {
      if (packet.t === 'INTERACTION_CREATE') {
        logger.info('Received raw Discord INTERACTION_CREATE packet', {
          id: packet.d?.id,
          type: packet.d?.type,
          command: packet.d?.data?.name ?? null,
          guildId: packet.d?.guild_id ?? null
        });
        return;
      }

      if (packet.t === 'VOICE_STATE_UPDATE' && packet.d?.guild_id) {
        const diagnostics = this.getVoiceGatewayDiagnostics(packet.d.guild_id);
        diagnostics.voiceStateUpdates += 1;
        diagnostics.lastVoiceStateUpdateAt = new Date().toISOString();
        if (packet.d.user_id === this.client?.user?.id) {
          diagnostics.lastBotVoiceChannelId = packet.d.channel_id ?? null;
          diagnostics.lastBotVoiceSessionId = packet.d.session_id ?? null;
          this.forwardRawVoiceStateUpdate(packet.d);
        }
        return;
      }

      if (packet.t === 'VOICE_SERVER_UPDATE' && packet.d?.guild_id) {
        const diagnostics = this.getVoiceGatewayDiagnostics(packet.d.guild_id);
        diagnostics.voiceServerUpdates += 1;
        diagnostics.lastVoiceServerUpdateAt = new Date().toISOString();
        this.forwardRawVoiceServerUpdate(packet.d);
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
      void this.synchronizePlatformGuilds();
      void this.restoreWatchedVoiceConnections();
      void this.initializeWatchedTextSessions();
      this.startVoiceWatchReconciliation();
    });
    this.client.on(Events.GuildCreate, (guild) => {
      void this.registerCommands();
      void this.synchronizePlatformGuild(guild.id);
      void this.initializeWatchedTextSessions(guild.id);
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

  private async synchronizePlatformGuilds() {
    if (!this.platform) return;
    await Promise.all([...this.client?.guilds.cache.keys() ?? []].map((guildId) => this.synchronizePlatformGuild(guildId)));
  }

  private async synchronizePlatformGuild(guildId: string) {
    if (!this.platform) return;
    const guild = this.client?.guilds.cache.get(guildId);
    if (!guild) return;
    await this.platform.ensureGuild({ id: guild.id, name: guild.name, icon: guild.icon });
    const runtime = await this.platform.getGuildRuntime(guild.id);
    const localChannels = this.settings.get(guild.id);
    if (JSON.stringify([...localChannels.listeningChannelIds].sort()) !== JSON.stringify([...runtime.settings.listeningChannelIds].sort())) {
      this.settings.clearListeningChannels(guild.id);
      for (const channelId of runtime.settings.listeningChannelIds) this.settings.addListeningChannel(guild.id, channelId);
    }
    if (JSON.stringify([...localChannels.voiceWatchChannelIds].sort()) !== JSON.stringify([...runtime.settings.voiceWatchChannelIds].sort())) {
      this.settings.clearVoiceWatchChannels(guild.id);
      for (const channelId of runtime.settings.voiceWatchChannelIds) this.settings.addVoiceWatchChannel(guild.id, channelId);
    }
    const me = await guild.members.fetchMe().catch(() => null);
    if (!me) return;
    const effectiveNickname = runtime.features.customIdentity ? runtime.settings.nickname : null;
    const effectiveAvatarUrl = runtime.features.customIdentity ? runtime.settings.avatarUrl : null;
    const identitySignature = JSON.stringify([effectiveNickname, effectiveAvatarUrl]);
    if (this.appliedIdentitySignatures.get(guildId) === identitySignature) return;
    const patch: { nick?: string | null; avatar?: Buffer | null } = {};
    let avatarLoadFailed = false;
    if ((me.nickname ?? null) !== effectiveNickname) patch.nick = effectiveNickname;
    if (effectiveAvatarUrl) {
      const avatar = await fetchRemoteAvatar(effectiveAvatarUrl, this.config.GIADA_PUBLIC_URL).catch(() => null);
      if (avatar) patch.avatar = avatar;
      else avatarLoadFailed = true;
    } else if (me.avatar) patch.avatar = null;
    if (avatarLoadFailed) return;
    if (Object.keys(patch).length) {
      const applied = await guild.members.editMe(patch).then(() => true).catch((error) => {
        logger.warn('Could not apply per-guild bot identity', {
        guildId,
        error: error instanceof Error ? error.message : String(error)
        });
        return false;
      });
      if (!applied) return;
    }
    this.appliedIdentitySignatures.set(guildId, identitySignature);
  }

  async stop() {
    if (this.voiceWatchReconcileInterval) {
      clearInterval(this.voiceWatchReconcileInterval);
      this.voiceWatchReconcileInterval = null;
    }
    for (const timer of this.voiceReadyTimers.values()) {
      clearTimeout(timer);
    }
    this.voiceReadyTimers.clear();
    for (const timer of this.voiceRejoinTimers.values()) {
      clearTimeout(timer);
    }
    this.voiceRejoinTimers.clear();
    for (const timer of this.voiceTextMessageIds.values()) {
      clearTimeout(timer);
    }
    this.voiceTextMessageIds.clear();
    this.responder.disposeAll();
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
        gifProvider: this.config.GIF_PROVIDER,
        giphyConfigured: Boolean(this.config.GIPHY_API_KEY?.trim()),
        tenorConfigured: Boolean(this.config.TENOR_API_KEY?.trim()),
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
      })),
      voiceWatch: [...(this.client?.guilds.cache.values() ?? [])]
        .flatMap((guild) => this.settings.get(guild.id).voiceWatchChannelIds.map((channelId) => {
          const connection = getVoiceConnection(guild.id);
          const key = voiceBridgeKey(guild.id, channelId);
          return {
            guildId: guild.id,
            channelId,
            humanMembers: this.countHumanVoiceMembers(guild.id, channelId),
            connectedChannelId: connection?.joinConfig.channelId ?? null,
            bridgeActive: this.voiceBridges.has(key),
            readyTimerActive: this.voiceReadyTimers.has(key),
            rejoinScheduled: this.voiceRejoinTimers.has(key),
            readyReconnectAttempts: this.voiceReadyReconnectAttempts.get(key) ?? 0,
            gateway: this.getVoiceGatewayDiagnostics(guild.id),
            connection: this.getVoiceConnectionDiagnostics(guild.id)
          };
        })),
      voiceBridges: [...this.voiceBridges.values()].map((bridge) => bridge.getStatus())
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
    if (message.author.id === this.client?.user?.id || !message.guildId) {
      return;
    }
    const guildId = message.guildId;
    if (this.platform && message.guild) {
      await this.platform.ensureGuild({ id: message.guild.id, name: message.guild.name, icon: message.guild.icon });
    }

    const addressed = await this.isAddressed(message);
    const voiceTextBridge = this.getConnectedVoiceTextBridge(message);
    if (voiceTextBridge) {
      if (this.hasSeenVoiceTextMessage(message.id)) {
        return;
      }
      const safeInput = assertDiscordSafe(message.content);
      this.storeMessageAuthorIdentity(message);
      if (safeInput.text.trim()) {
        logger.info('Discord text message forwarded to active voice bridge instead of text reply', {
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          textLength: safeInput.text.length
        });
        voiceTextBridge.speakTextChatMessage(message.member?.displayName ?? message.author.username, safeInput.text);
      }
      return;
    }

    const settings = this.settings.get(message.guildId);
    const listeningChannel = settings.listeningChannelIds.includes(message.channelId);
    if (!listeningChannel && !addressed) {
      return;
    }

    const safeInput = assertDiscordSafe(message.content);
    if (!safeInput.ok) {
      await this.reply(message, safeInput.text);
      return;
    }
    this.storeMessageAuthorIdentity(message);

    if ('sendTyping' in message.channel && typeof message.channel.sendTyping === 'function') {
      await message.channel.sendTyping().catch((error) => {
        logger.warn('Could not send Discord typing indicator', {
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
    const context = await this.collectMessageContext(message);
    const channelNsfw = await this.isMessageChannelNsfw(message);
    const response = await this.responder.reply({
      guildId: message.guildId,
      channelId: message.channelId,
      channelNsfw,
      authorName: message.member?.displayName ?? message.author.username,
      authorId: message.author.id,
      text: safeInput.text,
      replyTo: context.replyTo,
      recentMessages: context.recentMessages,
      images: context.images,
      mayStaySilent: false,
      reactionTargetMessageIds: context.reactionTargetMessageIds,
      addReaction: (messageId, emoji) => this.addReactionToContextMessage(message, context.reactionTargetMessageIds, messageId, emoji),
      sendGif: (url, caption) => this.sendGifToMessageChannel(message, url, caption),
      joinRequesterVoiceChannel: () => this.joinRequesterVoiceFromText(guildId, message.author.id),
      leaveVoiceChannel: () => this.leaveVoiceFromTool(guildId),
      knownUsers: this.settings.listUserIdentities(message.guildId).map((user) => ({
        userId: user.userId,
        username: user.username,
        displayName: user.displayName
      }))
    });
    if (!response) {
      logger.info('Discord text responder produced no Discord reply', {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        addressed,
        listeningChannel
      });
      return;
    }
    await this.reply(message, response);
  }

  private hasSeenVoiceTextMessage(messageId: string) {
    if (this.voiceTextMessageIds.has(messageId)) {
      return true;
    }
    const timer = setTimeout(() => {
      this.voiceTextMessageIds.delete(messageId);
    }, VOICE_TEXT_MESSAGE_DEDUPE_MS);
    this.voiceTextMessageIds.set(messageId, timer);
    return false;
  }

  private getConnectedVoiceTextBridge(message: Message) {
    if (!message.guildId) {
      return null;
    }
    const connection = getVoiceConnection(message.guildId);
    const voiceChannelId = connection?.joinConfig.channelId;
    if (connection?.state.status !== VoiceConnectionStatus.Ready || !voiceChannelId) {
      return null;
    }
    const bridge = this.voiceBridges.get(voiceBridgeKey(message.guildId, voiceChannelId));
    if (!bridge) {
      return null;
    }
    if (isVoiceTextChannelMessage(message, voiceChannelId)) {
      return bridge;
    }
    return null;
  }

  private async isMessageChannelNsfw(message: Message) {
    if (hasBooleanNsfw(message.channel)) {
      return message.channel.nsfw;
    }

    const threadParent = getThreadParent(message.channel);
    if (hasBooleanNsfw(threadParent)) {
      return threadParent.nsfw;
    }

    const guild = message.guild;
    if (!guild) {
      return false;
    }

    const fetchedChannel = await guild.channels.fetch(message.channelId).catch(() => null);
    if (hasBooleanNsfw(fetchedChannel)) {
      return fetchedChannel.nsfw;
    }

    const fetchedParentId = getThreadParentId(fetchedChannel) ?? getThreadParentId(message.channel);
    if (!fetchedParentId) {
      return false;
    }

    const fetchedParent = await guild.channels.fetch(fetchedParentId).catch(() => null);
    return hasBooleanNsfw(fetchedParent) ? fetchedParent.nsfw : false;
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
    const canManageAccess = this.hasGatewayAdminOrOwner(interaction);
    const canRunCommand = canManageAccess || this.settings.isUserAuthorized(interaction.guildId, interaction.user.id);
    if ((subcommand === 'authorize' || subcommand === 'deauthorize') && !canManageAccess) {
      await this.replyInteraction(interaction, 'Only a Discord Administrator or the Giada owner can manage Giada command access.');
      return;
    }
    if (subcommand !== 'authorize' && subcommand !== 'deauthorize' && !canRunCommand) {
      await this.replyInteraction(interaction, 'You are not authorized to run Giada commands. Ask a Discord Administrator to run `/giada authorize user:@you`.');
      return;
    }

    if (subcommand === 'authorize') {
      const user = interaction.options.getUser('user', true);
      this.settings.authorizeUser(interaction.guildId, user.id, interaction.user.id);
      await this.replyInteraction(interaction, `Authorized <@${user.id}> to run Giada commands.`);
      return;
    }

    if (subcommand === 'deauthorize') {
      const user = interaction.options.getUser('user', true);
      if (this.isOwnerUser(user.id)) {
        await this.replyInteraction(interaction, 'The Giada owner cannot be deauthorized.');
        return;
      }
      this.settings.deauthorizeUser(interaction.guildId, user.id);
      await this.replyInteraction(interaction, `Removed Giada command authorization for <@${user.id}>.`);
      return;
    }

    if (subcommand === 'help') {
      await this.replyInteraction(interaction, this.helpText());
      return;
    }

    if (subcommand === 'status') {
      await this.replyInteraction(interaction, this.statusText(interaction.guildId));
      return;
    }

    if (subcommand === 'listen') {
      const mode = interaction.options.getString('mode', true);
      const channelId = interaction.options.getChannel('channel')?.id ?? interaction.channelId;
      if (mode === 'off') {
        this.settings.removeListeningChannel(interaction.guildId, channelId);
        this.responder.disposeChannel(interaction.guildId, channelId);
        await this.replyInteraction(interaction, `Listening disabled for <#${channelId}>. I will answer there only when named or mentioned.`);
        return;
      }
      this.settings.addListeningChannel(interaction.guildId, channelId);
      await this.initializeWatchedTextChannel(interaction.guildId, channelId);
      await this.replyInteraction(interaction, `Listening enabled for <#${channelId}>. I will watch the conversation there and reply when it makes sense.`);
      return;
    }

    if (subcommand === 'voice') {
      const mode = interaction.options.getString('mode', true);
      if (mode === 'off') {
        const selected = interaction.options.getChannel('channel')?.id;
        const activeChannelId = selected ?? getVoiceConnection(interaction.guildId)?.joinConfig.channelId ?? null;
        if (activeChannelId) {
          this.settings.removeVoiceWatchChannel(interaction.guildId, activeChannelId);
          this.destroyVoiceBridge(interaction.guildId, activeChannelId);
          const connection = getVoiceConnection(interaction.guildId);
          if (connection?.joinConfig.channelId === activeChannelId) {
            connection.destroy();
          }
          await this.replyInteraction(interaction, `Voice watch disabled for <#${activeChannelId}>.`);
        } else {
          this.settings.clearVoiceWatchChannels(interaction.guildId);
          this.destroyAllVoiceBridgesForGuild(interaction.guildId);
          getVoiceConnection(interaction.guildId)?.destroy();
          await this.replyInteraction(interaction, 'Voice watch disabled for all watched channels.');
        }
        return;
      }

      const voiceChannelId = await this.resolveVoiceChannelId(interaction);
      if (!voiceChannelId) {
        await this.replyInteraction(interaction, 'Join a voice channel first, or choose a voice channel.');
        return;
      }

      if (mode === 'watch') {
        this.settings.addVoiceWatchChannel(interaction.guildId, voiceChannelId);
        await this.replyInteraction(interaction, `Voice watch enabled for <#${voiceChannelId}>. I will join when someone enters and leave after everyone leaves.`);
        await this.joinWatchedVoiceIfNeeded(interaction.guildId, voiceChannelId);
        return;
      }

      if (mode === 'join') {
        await this.joinVoice(interaction.guildId, voiceChannelId);
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
    const userId = payload.member?.user?.id ?? payload.user?.id;
    const canManageAccess = this.hasHttpAdminOrOwner(payload);
    const canRunCommand = Boolean(userId && (canManageAccess || this.settings.isUserAuthorized(payload.guild_id, userId)));
    if ((subcommand?.name === 'authorize' || subcommand?.name === 'deauthorize') && !canManageAccess) {
      await this.updateHttpInteraction(payload, 'Only a Discord Administrator or the Giada owner can manage Giada command access.');
      return;
    }
    if (subcommand?.name !== 'authorize' && subcommand?.name !== 'deauthorize' && !canRunCommand) {
      await this.updateHttpInteraction(payload, 'You are not authorized to run Giada commands. Ask a Discord Administrator to run `/giada authorize user:@you`.');
      return;
    }

    if (subcommand?.name === 'authorize') {
      const targetUserId = getHttpStringOption(subcommand, 'user');
      if (!targetUserId || !userId) {
        await this.updateHttpInteraction(payload, 'Choose a user to authorize.');
        return;
      }
      this.settings.authorizeUser(payload.guild_id, targetUserId, userId);
      await this.updateHttpInteraction(payload, `Authorized <@${targetUserId}> to run Giada commands.`);
      return;
    }

    if (subcommand?.name === 'deauthorize') {
      const targetUserId = getHttpStringOption(subcommand, 'user');
      if (!targetUserId) {
        await this.updateHttpInteraction(payload, 'Choose a user to deauthorize.');
        return;
      }
      if (this.isOwnerUser(targetUserId)) {
        await this.updateHttpInteraction(payload, 'The Giada owner cannot be deauthorized.');
        return;
      }
      this.settings.deauthorizeUser(payload.guild_id, targetUserId);
      await this.updateHttpInteraction(payload, `Removed Giada command authorization for <@${targetUserId}>.`);
      return;
    }

    if (subcommand?.name === 'help') {
      await this.updateHttpInteraction(payload, this.helpText());
      return;
    }

    if (subcommand?.name === 'status') {
      await this.updateHttpInteraction(payload, this.statusText(payload.guild_id));
      return;
    }

    if (subcommand?.name === 'listen') {
      const mode = getHttpStringOption(subcommand, 'mode');
      const channelId = getHttpStringOption(subcommand, 'channel') ?? payload.channel_id;
      if (!channelId) {
        await this.updateHttpInteraction(payload, 'Choose a text channel or run this command inside one.');
        return;
      }
      if (mode === 'off') {
        this.settings.removeListeningChannel(payload.guild_id, channelId);
        this.responder.disposeChannel(payload.guild_id, channelId);
        await this.updateHttpInteraction(payload, `Listening disabled for <#${channelId}>. I will answer there only when named or mentioned.`);
        return;
      }
      this.settings.addListeningChannel(payload.guild_id, channelId);
      await this.initializeWatchedTextChannel(payload.guild_id, channelId);
      await this.updateHttpInteraction(payload, `Listening enabled for <#${channelId}>. I will watch the conversation there and reply when it makes sense.`);
      return;
    }

    if (subcommand?.name === 'voice') {
      const mode = getHttpStringOption(subcommand, 'mode');
      if (mode === 'off') {
        const selected = getHttpStringOption(subcommand, 'channel');
        const activeChannelId = selected ?? getVoiceConnection(payload.guild_id)?.joinConfig.channelId ?? null;
        if (activeChannelId) {
          this.settings.removeVoiceWatchChannel(payload.guild_id, activeChannelId);
          this.destroyVoiceBridge(payload.guild_id, activeChannelId);
          const connection = getVoiceConnection(payload.guild_id);
          if (connection?.joinConfig.channelId === activeChannelId) {
            connection.destroy();
          }
          await this.updateHttpInteraction(payload, `Voice watch disabled for <#${activeChannelId}>.`);
        } else {
          this.settings.clearVoiceWatchChannels(payload.guild_id);
          this.destroyAllVoiceBridgesForGuild(payload.guild_id);
          getVoiceConnection(payload.guild_id)?.destroy();
          await this.updateHttpInteraction(payload, 'Voice watch disabled for all watched channels.');
        }
        return;
      }

      const voiceChannelId = this.resolveHttpVoiceChannelId(payload, subcommand);
      if (!voiceChannelId) {
        await this.updateHttpInteraction(payload, 'Join a voice channel first, or choose a voice channel.');
        return;
      }

      if (mode === 'watch') {
        this.settings.addVoiceWatchChannel(payload.guild_id, voiceChannelId);
        await this.updateHttpInteraction(payload, `Voice watch enabled for <#${voiceChannelId}>. I will join when someone enters and leave after everyone leaves.`);
        await this.joinWatchedVoiceIfNeeded(payload.guild_id, voiceChannelId);
        return;
      }

      if (mode === 'join') {
        await this.joinVoice(payload.guild_id, voiceChannelId);
        await this.updateHttpInteraction(payload, 'Joined voice. I will listen and reply with voice while connected.');
        return;
      }
    }

    await this.updateHttpInteraction(payload, 'Unknown `/giada` command.');
  }

  private async registerCommands() {
    const client = this.client;
    await registerDiscordCommands(
      this.config,
      client?.application?.id || client?.user?.id || null,
      client?.guilds.cache.map((guild) => guild.id) ?? []
    );
  }

  private async handleVoiceStateUpdate(oldState: VoiceState, newState: VoiceState) {
    const guildId = newState.guild.id;
    const botUserId = this.client?.user?.id;
    const isBotVoiceState = Boolean(botUserId && oldState.id === botUserId);
    const connection = getVoiceConnection(guildId);
    const connectedChannelId = connection?.joinConfig.channelId ?? null;
    if (
      !isBotVoiceState
      && connectedChannelId
      && (oldState.channelId === connectedChannelId || newState.channelId === connectedChannelId)
    ) {
      this.scheduleLeaveVoiceIfEmpty(guildId, connectedChannelId);
    }

    const settings = this.settings.get(guildId);
    if (!settings.voiceWatchChannelIds.length) {
      return;
    }

    const watchedChannelIds = settings.voiceWatchChannelIds;
    if (isBotVoiceState && oldState.channelId && watchedChannelIds.includes(oldState.channelId) && newState.channelId !== oldState.channelId) {
      this.scheduleVoiceRejoin(guildId, oldState.channelId, VOICE_REJOIN_DELAY_MS);
      return;
    }

    if (newState.channelId && watchedChannelIds.includes(newState.channelId)) {
      await this.joinWatchedVoiceIfNeeded(guildId, newState.channelId);
      return;
    }

    if ((oldState.channelId && watchedChannelIds.includes(oldState.channelId)) || (newState.channelId && watchedChannelIds.includes(newState.channelId))) {
      const channelId = oldState.channelId && watchedChannelIds.includes(oldState.channelId) ? oldState.channelId : newState.channelId;
      if (channelId) {
        this.scheduleLeaveVoiceIfEmpty(guildId, channelId);
      }
    }
  }

  private async joinWatchedVoiceIfNeeded(guildId: string, channelId: string) {
    const guild = this.client?.guilds.cache.get(guildId);
    if (guild) {
      await guild.channels.fetch(channelId).catch(() => null);
    }
    const existingConnection = getVoiceConnection(guildId);
    const existingChannelId = existingConnection?.joinConfig.channelId;
    if (
      existingConnection
      && existingConnection.state.status !== VoiceConnectionStatus.Destroyed
      && existingChannelId
      && existingChannelId !== channelId
      && this.countHumanVoiceMembers(guildId, existingChannelId) > 0
    ) {
      return;
    }
    const humanMembers = this.countHumanVoiceMembers(guildId, channelId);
    if (humanMembers <= 0) {
      return;
    }
    await this.joinVoice(guildId, channelId);
  }

  private scheduleLeaveVoiceIfEmpty(guildId: string, channelId: string) {
    setTimeout(() => {
      this.leaveVoiceIfEmpty(guildId, channelId);
    }, 1000);
  }

  private leaveVoiceIfEmpty(guildId: string, channelId: string) {
    const humanMembers = this.countHumanVoiceMembers(guildId, channelId);
    if (humanMembers > 0) {
      return;
    }
    const connection = getVoiceConnection(guildId);
    if (connection?.joinConfig.channelId !== channelId) {
      return;
    }
    this.destroyVoiceBridge(guildId, channelId);
    connection.destroy();
  }

  private leaveWatchedVoiceIfEmpty(guildId: string, channelId: string) {
    this.leaveVoiceIfEmpty(guildId, channelId);
  }

  private async joinRequesterVoiceFromText(guildId: string, userId: string) {
    const settings = this.settings.get(guildId);
    if (settings.voiceWatchChannelIds.length > 0) {
      return {
        ok: false,
        error: 'voice_watch_enabled',
        watchedChannelIds: settings.voiceWatchChannelIds
      };
    }

    const guild = this.client?.guilds.cache.get(guildId);
    if (!guild) {
      return { ok: false, error: 'guild_not_cached' };
    }

    const member = await guild.members.fetch(userId).catch(() => null);
    const channelId = member?.voice.channelId ?? guild.voiceStates.cache.get(userId)?.channelId ?? null;
    if (!channelId) {
      return { ok: false, error: 'requester_not_in_voice' };
    }

    await this.joinVoice(guildId, channelId);
    return {
      ok: true,
      channelId,
      message: `Joined <#${channelId}>.`
    };
  }

  private async leaveVoiceFromTool(guildId: string, expectedChannelId?: string) {
    const settings = this.settings.get(guildId);
    if (settings.voiceWatchChannelIds.length > 0) {
      return {
        ok: false,
        error: 'voice_watch_enabled',
        watchedChannelIds: settings.voiceWatchChannelIds
      };
    }

    const connection = getVoiceConnection(guildId);
    const channelId = connection?.joinConfig.channelId ?? null;
    if (!connection || !channelId || connection.state.status === VoiceConnectionStatus.Destroyed) {
      return { ok: false, error: 'not_connected_to_voice' };
    }
    if (expectedChannelId && channelId !== expectedChannelId) {
      return { ok: false, error: 'connected_to_different_voice_channel', channelId };
    }

    this.destroyVoiceBridge(guildId, channelId);
    connection.destroy();
    return {
      ok: true,
      channelId,
      message: `Left <#${channelId}>.`
    };
  }

  private async joinVoice(guildId: string, channelId: string) {
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
    const voiceBridge = await this.getVoiceBridge(guildId, channelId, botUserId);
    await guild.members.fetchMe().catch((error) => {
      logger.warn('Could not fetch Discord bot guild member before joining voice', {
        guildId,
        channelId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    this.warnIfVoicePermissionsAreMissing(guildId, channelId, botUserId);
    const existingConnection = getVoiceConnection(guildId);
    if (existingConnection?.joinConfig.channelId === channelId) {
      if (existingConnection.state.status === VoiceConnectionStatus.Destroyed) {
        this.destroyVoiceBridge(guildId, channelId);
      } else {
        this.attachVoiceConnectionDiagnostics(guildId, channelId, existingConnection);
        voiceBridge.attach(existingConnection, channelId);
        this.watchVoiceReady(guildId, channelId, existingConnection);
        this.unsuppressStageVoiceIfNeeded(guildId, channelId);
        return;
      }
    } else if (existingConnection) {
      const existingChannelId = existingConnection.joinConfig.channelId;
      if (existingChannelId) {
        this.destroyVoiceBridge(guildId, existingChannelId);
      }
      this.destroyVoiceConnection(existingConnection, guildId, channelId);
    }
    const connection = joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator: this.createVoiceAdapterCreator(guild.voiceAdapterCreator as unknown as DiscordGatewayAdapterCreator, guildId),
      selfDeaf: false,
      selfMute: false,
      debug: true
    });
    this.attachVoiceConnectionDiagnostics(guildId, channelId, connection);
    voiceBridge.attach(connection, channelId);
    this.watchVoiceReady(guildId, channelId, connection);
    this.unsuppressStageVoiceIfNeeded(guildId, channelId);
  }

  private watchVoiceReady(guildId: string, channelId: string, connection: ReturnType<typeof joinVoiceChannel>) {
    const key = voiceBridgeKey(guildId, channelId);
    if (this.voiceReadyTimers.has(key)) {
      return;
    }
    if (connection.state.status === VoiceConnectionStatus.Ready || connection.state.status === VoiceConnectionStatus.Destroyed) {
      return;
    }
    const clearReadyTimer = () => {
      const activeTimer = this.voiceReadyTimers.get(key);
      if (activeTimer) {
        clearTimeout(activeTimer);
        this.voiceReadyTimers.delete(key);
      }
    };
    const timer = setTimeout(() => {
      this.voiceReadyTimers.delete(key);
      if (connection.state.status === VoiceConnectionStatus.Ready || connection.state.status === VoiceConnectionStatus.Destroyed) {
        return;
      }
      if (connection.joinConfig.channelId !== channelId || this.countHumanVoiceMembers(guildId, channelId) <= 0) {
        return;
      }
      logger.warn('Discord voice connection did not become ready; reconnecting', {
        guildId,
        channelId,
        status: connection.state.status,
        gateway: this.getVoiceGatewayDiagnostics(guildId)
      });
      this.voiceReadyReconnectAttempts.set(key, (this.voiceReadyReconnectAttempts.get(key) ?? 0) + 1);
      this.destroyVoiceBridge(guildId, channelId);
      this.destroyVoiceConnection(connection, guildId, channelId);
      this.scheduleVoiceRejoin(guildId, channelId, VOICE_REJOIN_DELAY_MS);
    }, VOICE_READY_TIMEOUT_MS);
    this.voiceReadyTimers.set(key, timer);
    connection.once(VoiceConnectionStatus.Ready, clearReadyTimer);
    connection.once(VoiceConnectionStatus.Destroyed, clearReadyTimer);
    queueMicrotask(() => {
      if (connection.state.status === VoiceConnectionStatus.Ready || connection.state.status === VoiceConnectionStatus.Destroyed) {
        clearReadyTimer();
      }
    });
  }

  private destroyVoiceConnection(connection: ReturnType<typeof joinVoiceChannel>, guildId: string, channelId: string) {
    try {
      connection.destroy();
    } catch (error) {
      logger.warn('Failed to destroy Discord voice connection', {
        guildId,
        channelId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private scheduleVoiceRejoin(guildId: string, channelId: string, delayMs: number) {
    const key = voiceBridgeKey(guildId, channelId);
    if (this.voiceRejoinTimers.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      this.voiceRejoinTimers.delete(key);
      if (this.countHumanVoiceMembers(guildId, channelId) > 0) {
        void this.joinVoice(guildId, channelId);
      }
    }, delayMs);
    this.voiceRejoinTimers.set(key, timer);
  }

  private warnIfVoicePermissionsAreMissing(guildId: string, channelId: string, botUserId: string) {
    const guild = this.client?.guilds.cache.get(guildId);
    const channel = guild?.channels.cache.get(channelId);
    if (!channel?.isVoiceBased()) {
      logger.warn('Cannot verify Discord voice permissions because the channel is not cached as a voice channel', {
        guildId,
        channelId
      });
      return;
    }

    const permissions = channel.permissionsFor(botUserId);
    if (!permissions) {
      logger.warn('Cannot verify Discord voice permissions because permissions could not be resolved', {
        guildId,
        channelId,
        botUserId
      });
      return;
    }

    const requiredPermissions: Array<[bigint, string]> = [
      [PermissionFlagsBits.ViewChannel, 'ViewChannel'],
      [PermissionFlagsBits.Connect, 'Connect'],
      [PermissionFlagsBits.Speak, 'Speak']
    ];
    const missing = requiredPermissions
      .filter(([permission]) => !permissions.has(permission))
      .map(([, name]) => name);

    if (missing.length > 0) {
      logger.warn('Discord bot is missing voice channel permissions', {
        guildId,
        channelId,
        missing
      });
    }
  }

  private attachVoiceConnectionDiagnostics(guildId: string, channelId: string, connection: ReturnType<typeof joinVoiceChannel>) {
    if (this.diagnosedVoiceConnections.has(connection)) {
      return;
    }
    this.diagnosedVoiceConnections.add(connection);

    connection.on('debug', (message) => {
      this.getVoiceConnectionDiagnostics(guildId).lastDebug = message;
      logger.debug('Discord voice connection debug', {
        guildId,
        channelId,
        message
      });
    });
    connection.on('error', (error) => {
      this.getVoiceConnectionDiagnostics(guildId).lastError = error instanceof Error ? error.message : String(error);
      logger.warn('Discord voice connection error', {
        guildId,
        channelId,
        status: connection.state.status,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    connection.on('stateChange', (oldState, newState) => {
      const diagnostics = this.getVoiceConnectionDiagnostics(guildId);
      diagnostics.stateChanges += 1;
      diagnostics.lastStateChangeAt = new Date().toISOString();
      diagnostics.lastOldStatus = oldState.status;
      diagnostics.lastNewStatus = newState.status;
      diagnostics.lastReason = 'reason' in newState ? newState.reason : null;
      diagnostics.lastCloseCode = 'closeCode' in newState ? newState.closeCode : null;
      logger.debug('Discord voice connection state changed', {
        guildId,
        channelId,
        oldStatus: oldState.status,
        newStatus: newState.status,
        reason: 'reason' in newState ? newState.reason : null,
        closeCode: 'closeCode' in newState ? newState.closeCode : null,
        gateway: this.getVoiceGatewayDiagnostics(guildId)
      });
    });
  }

  private getVoiceGatewayDiagnostics(guildId: string) {
    let diagnostics = this.voiceGatewayDiagnostics.get(guildId);
    if (!diagnostics) {
      diagnostics = {
        voiceStateUpdates: 0,
        voiceServerUpdates: 0,
        adapterVoiceStateUpdates: 0,
        adapterVoiceServerUpdates: 0,
        lastVoiceStateUpdateAt: null,
        lastVoiceServerUpdateAt: null,
        lastAdapterVoiceStateUpdateAt: null,
        lastAdapterVoiceServerUpdateAt: null,
        lastBotVoiceChannelId: null,
        lastBotVoiceSessionId: null
      };
      this.voiceGatewayDiagnostics.set(guildId, diagnostics);
    }
    return diagnostics;
  }

  private getVoiceConnectionDiagnostics(guildId: string) {
    let diagnostics = this.voiceConnectionDiagnostics.get(guildId);
    if (!diagnostics) {
      diagnostics = {
        stateChanges: 0,
        lastStateChangeAt: null,
        lastOldStatus: null,
        lastNewStatus: null,
        lastReason: null,
        lastCloseCode: null,
        lastError: null,
        lastDebug: null
      };
      this.voiceConnectionDiagnostics.set(guildId, diagnostics);
    }
    return diagnostics;
  }

  private createVoiceAdapterCreator(baseCreator: DiscordGatewayAdapterCreator, guildId: string): DiscordGatewayAdapterCreator {
    return (methods) => {
      const activeAdapter: ActiveVoiceAdapter = {
        methods: {
          destroy: () => methods.destroy(),
          onVoiceServerUpdate: (data) => {
            const key = `${data.guild_id}:${data.endpoint ?? 'null'}:${data.token}`;
            if (activeAdapter.lastVoiceServerKey === key) {
              return;
            }
            activeAdapter.lastVoiceServerKey = key;
            const diagnostics = this.getVoiceGatewayDiagnostics(guildId);
            diagnostics.adapterVoiceServerUpdates += 1;
            diagnostics.lastAdapterVoiceServerUpdateAt = new Date().toISOString();
            methods.onVoiceServerUpdate(data);
          },
          onVoiceStateUpdate: (data) => {
            const key = `${data.guild_id}:${data.user_id}:${data.session_id}:${data.channel_id ?? 'null'}`;
            if (activeAdapter.lastVoiceStateKey === key) {
              return;
            }
            activeAdapter.lastVoiceStateKey = key;
            const diagnostics = this.getVoiceGatewayDiagnostics(guildId);
            diagnostics.adapterVoiceStateUpdates += 1;
            diagnostics.lastAdapterVoiceStateUpdateAt = new Date().toISOString();
            methods.onVoiceStateUpdate(data);
          }
        },
        lastVoiceStateKey: null,
        lastVoiceServerKey: null
      };
      this.activeVoiceAdapters.set(guildId, activeAdapter);
      const implementer = baseCreator(activeAdapter.methods);
      return this.wrapVoiceAdapterImplementer(guildId, activeAdapter, implementer);
    };
  }

  private wrapVoiceAdapterImplementer(
    guildId: string,
    activeAdapter: ActiveVoiceAdapter,
    implementer: DiscordGatewayAdapterImplementerMethods
  ): DiscordGatewayAdapterImplementerMethods {
    return {
      sendPayload: (payload) => implementer.sendPayload(payload),
      destroy: () => {
        if (this.activeVoiceAdapters.get(guildId) === activeAdapter) {
          this.activeVoiceAdapters.delete(guildId);
        }
        implementer.destroy();
      }
    };
  }

  private forwardRawVoiceStateUpdate(data: { guild_id?: string; user_id?: string; channel_id?: string | null; session_id?: string | null }) {
    if (!data.guild_id || !data.user_id || !data.session_id) {
      return;
    }
    this.activeVoiceAdapters.get(data.guild_id)?.methods.onVoiceStateUpdate(data as Parameters<DiscordGatewayAdapterLibraryMethods['onVoiceStateUpdate']>[0]);
  }

  private forwardRawVoiceServerUpdate(data: { guild_id?: string }) {
    if (!data.guild_id) {
      return;
    }
    this.activeVoiceAdapters.get(data.guild_id)?.methods.onVoiceServerUpdate(data as Parameters<DiscordGatewayAdapterLibraryMethods['onVoiceServerUpdate']>[0]);
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
      for (const channelId of this.settings.get(guild.id).voiceWatchChannelIds) {
        await this.joinWatchedVoiceIfNeeded(guild.id, channelId);
      }
    }
  }

  private startVoiceWatchReconciliation() {
    if (this.voiceWatchReconcileInterval) {
      return;
    }
    this.voiceWatchReconcileInterval = setInterval(() => {
      void this.reconcileWatchedVoiceConnections();
    }, VOICE_WATCH_RECONCILE_MS);
  }

  private async reconcileWatchedVoiceConnections() {
    for (const guild of this.client?.guilds.cache.values() ?? []) {
      await this.synchronizePlatformGuild(guild.id);
      for (const channelId of this.settings.get(guild.id).voiceWatchChannelIds) {
        await this.joinWatchedVoiceIfNeeded(guild.id, channelId);
        this.leaveWatchedVoiceIfEmpty(guild.id, channelId);
      }
    }
  }

  private async getVoiceBridge(guildId: string, channelId: string, botUserId: string) {
    const key = voiceBridgeKey(guildId, channelId);
    let bridge = this.voiceBridges.get(key);
    if (!bridge) {
      let liveConfig = this.config;
      let personalityProvider: PersonalityInstructionProvider = this.personality;
      let geminiApiKey: string | undefined;
      let usage: { platform: PlatformStore; secondsPerCredit: number; reserveCredits: number } | undefined;
      let planFeatures: Awaited<ReturnType<PlatformStore['getGuildRuntime']>>['features'] | undefined;
      if (this.platform) {
        const runtime = await this.platform.getGuildRuntime(guildId);
        planFeatures = runtime.features;
        const byok = runtime.features.byokGemini ? await this.platform.getCredential(guildId, 'gemini') : null;
        let apiKey = byok;
        if (!apiKey && runtime.planKind === 'private' && runtime.features.geminiVoice) apiKey = (await this.platform.pickProviderKey('gemini_private'))?.value ?? null;
        if (!apiKey && runtime.planKind === 'paid' && runtime.features.geminiVoice) {
          const currentUsage = await this.platform.getUsage(guildId);
          const remaining = currentUsage.unlimited ? Number.MAX_SAFE_INTEGER : currentUsage.creditLimit - currentUsage.creditsUsed;
          if (remaining <= 0) throw new Error('voice_credits_exhausted');
          apiKey = (await this.platform.pickProviderKey('gemini_paid'))?.value ?? null;
          if (apiKey) usage = {
            platform: this.platform,
            secondsPerCredit: runtime.features.voiceSecondsPerCredit,
            reserveCredits: Math.max(1, Math.min(remaining, Math.ceil(240 / runtime.features.voiceSecondsPerCredit)))
          };
        }
        if (!apiKey || !runtime.features.geminiVoice) throw new Error('voice_not_enabled_for_plan');
        geminiApiKey = apiKey;
        liveConfig = {
          ...this.config,
          DISCORD_MUSIC_VOLUME: runtime.settings.musicVolume,
          DISCORD_MUSIC_DUCK_VOLUME: runtime.settings.musicDuckVolume,
          guildVoiceChanger: {
            ...runtime.settings.voiceChanger,
            enabled: runtime.features.voiceChanger && runtime.settings.voiceChanger.enabled
          }
        } as AppConfig;
        const effectivePersonality = personalityProfileForRuntime(runtime);
        personalityProvider = {
          buildInstruction: (surface, options) => buildPersonalityInstruction(
            effectivePersonality.profile,
            surface,
            { ...options, customInstructions: effectivePersonality.customInstructions }
          )
        };
      }
      bridge = new DiscordVoiceBridge(
        guildId,
        channelId,
        botUserId,
        (userId) => this.resolveVoiceSpeakerName(guildId, userId),
        () => this.leaveVoiceFromTool(guildId, channelId),
        liveConfig,
        this.platform?.guildMemory(guildId) ?? this.memory,
        personalityProvider,
        geminiApiKey,
        usage,
        planFeatures
      );
      this.voiceBridges.set(key, bridge);
    }
    return bridge;
  }

  private resolveVoiceSpeakerName(guildId: string, userId: string) {
    const guild = this.client?.guilds.cache.get(guildId);
    const voiceMember = guild?.voiceStates.cache.get(userId)?.member;
    const guildMember = guild?.members.cache.get(userId);
    const cachedUser = this.client?.users.cache.get(userId);
    const member = voiceMember ?? guildMember;
    if (member) {
      this.settings.upsertUserIdentity({
        guildId,
        userId,
        username: member.user.username,
        displayName: member.displayName
      });
    } else if (cachedUser) {
      this.settings.upsertUserIdentity({
        guildId,
        userId,
        username: cachedUser.username,
        displayName: cachedUser.globalName ?? cachedUser.username
      });
    }
    return voiceMember?.displayName
      ?? guildMember?.displayName
      ?? cachedUser?.globalName
      ?? cachedUser?.username
      ?? `Discord user ${userId}`;
  }

  private destroyVoiceBridge(guildId: string, channelId: string) {
    const key = voiceBridgeKey(guildId, channelId);
    const bridge = this.voiceBridges.get(key);
    const timer = this.voiceReadyTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.voiceReadyTimers.delete(key);
    }
    const rejoinTimer = this.voiceRejoinTimers.get(key);
    if (rejoinTimer) {
      clearTimeout(rejoinTimer);
      this.voiceRejoinTimers.delete(key);
    }
    if (!bridge) {
      return;
    }
    bridge.destroy();
    this.voiceBridges.delete(key);
  }

  private destroyAllVoiceBridgesForGuild(guildId: string) {
    for (const key of [...this.voiceBridges.keys()]) {
      const parsed = parseVoiceBridgeKey(key);
      if (parsed?.guildId === guildId) {
        this.destroyVoiceBridge(parsed.guildId, parsed.channelId);
      }
    }
  }

  private getMusicControllerForChannel(guildId: string, channelId: string) {
    const directBridge = this.voiceBridges.get(voiceBridgeKey(guildId, channelId));
    if (directBridge) {
      return directBridge;
    }
    const connection = getVoiceConnection(guildId);
    const voiceChannelId = connection?.joinConfig.channelId;
    if (connection?.state.status === VoiceConnectionStatus.Ready && voiceChannelId === channelId) {
      return this.voiceBridges.get(voiceBridgeKey(guildId, voiceChannelId));
    }
    return undefined;
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

  private async isAddressed(message: Message) {
    const botUser = this.client?.user;
    const names = this.platform && message.guildId
      ? await this.platform.getGuildRuntime(message.guildId).then((runtime) => [runtime.personality.name, runtime.settings.nickname].filter(Boolean) as string[])
      : [this.personality.get().name];
    const content = message.content.toLowerCase();
    return Boolean(botUser && message.mentions.has(botUser)) || names.some((name) => content.includes(name.toLowerCase()));
  }

  private async initializeWatchedTextSessions(onlyGuildId?: string) {
    const guilds = [...(this.client?.guilds.cache.values() ?? [])]
      .filter((guild) => !onlyGuildId || guild.id === onlyGuildId);
    for (const guild of guilds) {
      for (const channelId of this.settings.get(guild.id).listeningChannelIds) {
        await this.initializeWatchedTextChannel(guild.id, channelId);
      }
    }
  }

  private async initializeWatchedTextChannel(guildId: string, channelId: string) {
    const guild = this.client?.guilds.cache.get(guildId);
    if (!guild) {
      return;
    }
    const channel = guild.channels.cache.get(channelId)
      ?? await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      logger.warn('Could not initialize watched Discord text session because channel was not found', {
        guildId,
        channelId
      });
      return;
    }
    const parent = getThreadParent(channel);
    const channelNsfw = hasBooleanNsfw(channel)
      ? channel.nsfw
      : hasBooleanNsfw(parent) && parent.nsfw;
    try {
      await this.responder.initializeChannel(guildId, channelId, channelNsfw);
      logger.info('Initialized watched Discord text Live session', {
        guildId,
        channelId,
        channelNsfw
      });
    } catch (error) {
      logger.warn('Failed to initialize watched Discord text Live session', {
        guildId,
        channelId,
        channelNsfw,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async collectMessageContext(message: Message): Promise<{
    replyTo: DiscordContextMessage | null;
    recentMessages: DiscordContextMessage[];
    images: DiscordImageAttachment[];
    reactionTargetMessageIds: string[];
  }> {
    const images: DiscordImageAttachment[] = [];
    const recentMessagesPromise = this.fetchRecentMessages(message);
    const replyTo = await this.fetchReplyTarget(message, images);
    await this.collectAttachmentSummaries(message, 'current message', images);
    const recentMessages = await recentMessagesPromise;
    return {
      replyTo,
      recentMessages: recentMessages.slice(-10),
      images,
      reactionTargetMessageIds: [
        ...new Set([
          ...recentMessages.map((candidate) => candidate.messageId),
          ...(replyTo ? [replyTo.messageId] : []),
          message.id
        ])
      ]
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

    const fetched = await message.channel.messages.fetch({ limit: 21, before: message.id }).catch(() => null);
    if (!fetched) {
      return [];
    }

    return [...fetched.values()]
      .filter((candidate) => candidate.id !== message.id)
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .slice(-20)
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
        summary.skippedReason = 'visual media skipped: media limit reached';
        continue;
      }
      if (attachment.size > MAX_DISCORD_IMAGE_BYTES) {
        summary.skippedReason = 'visual media skipped: too large';
        continue;
      }
      const image = await this.downloadImageAttachment(attachment, `${scope} ${attachment.name ?? attachment.id}`);
      if (!image) {
        summary.skippedReason = 'visual media skipped: download failed';
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
      data: bytes.toString('base64'),
      sourceUrl: attachment.url
    };
  }

  private async sendGifToMessageChannel(message: Message, url: string, caption?: string) {
    if (!('send' in message.channel) || typeof message.channel.send !== 'function') {
      return { ok: false, error: 'channel_cannot_send_messages' };
    }
    const safeCaption = caption ? assertDiscordSafe(sanitizeForDiscord(caption)) : null;
    if (safeCaption && !safeCaption.ok) {
      return { ok: false, error: 'caption_failed_policy', reason: safeCaption.text };
    }
    const content = safeCaption?.text
      ? `${clampDiscordMessage(safeCaption.text)}\n${url}`
      : url;
    await message.channel.send({
      content,
      allowedMentions: allowedMentionsForContent(content)
    });
    return { ok: true };
  }

  private formatContextMessage(message: Message, attachments: DiscordAttachmentSummary[] = this.summarizeAttachments(message)): DiscordContextMessage {
    this.storeMessageAuthorIdentity(message);
    const content = sanitizeForDiscord(message.cleanContent || message.content || '[no text]').trim();

    return {
      messageId: message.id,
      authorName: message.member?.displayName ?? message.author.username,
      authorId: message.author.id,
      content: clampContextText(content),
      timestamp: message.createdAt.toISOString(),
      attachments,
      reactions: this.summarizeReactions(message)
    };
  }

  private summarizeReactions(message: Message): DiscordReactionSummary[] {
    return [...message.reactions.cache.values()]
      .filter((reaction) => reaction.count > 0)
      .slice(0, 12)
      .map((reaction) => ({
        emoji: reaction.emoji.toString(),
        count: reaction.count,
        reactedByBot: reaction.me
      }));
  }

  private async addReactionToContextMessage(sourceMessage: Message, allowedMessageIds: string[], messageId: string, emoji: string) {
    if (!allowedMessageIds.includes(messageId)) {
      return { ok: false, error: 'message_not_in_context' };
    }
    if (!('messages' in sourceMessage.channel)) {
      return { ok: false, error: 'channel_does_not_support_message_fetch' };
    }
    const target = await sourceMessage.channel.messages.fetch(messageId).catch(() => null);
    if (!target) {
      return { ok: false, error: 'message_not_found' };
    }
    await target.react(emoji);
    return { ok: true, messageId, emoji };
  }

  private storeMessageAuthorIdentity(message: Message) {
    if (!message.guildId || message.author.bot) {
      return;
    }
    this.settings.upsertUserIdentity({
      guildId: message.guildId,
      userId: message.author.id,
      username: message.author.username,
      displayName: message.member?.displayName ?? message.author.globalName ?? message.author.username
    });
  }

  private hasGatewayAdminOrOwner(interaction: ChatInputCommandInteraction) {
    return this.isOwnerUser(interaction.user.id)
      || Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
  }

  private async reply(message: Message, content: string) {
    const payload = {
      content,
      allowedMentions: allowedMentionsForContent(content)
    };
    await message.reply({
      ...payload,
      failIfNotExists: false
    }).catch(async (error) => {
      if (!isReplyFallbackError(error)) {
        throw error;
      }
      logger.warn('Discord reply target cannot be used; sending plain channel message instead', {
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        error: error instanceof Error ? error.message : String(error)
      });
      if (!('send' in message.channel) || typeof message.channel.send !== 'function') {
        throw error;
      }
      await message.channel.send(payload);
    });
  }

  private async replyInteraction(interaction: ChatInputCommandInteraction, content: string) {
    const payload = {
      content,
      allowedMentions: allowedMentionsForContent(content)
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
      '`/giada listen mode:here` - watch this text channel and reply when it makes sense.',
      '`/giada listen mode:off` - stop watching this text channel.',
      '`/giada voice mode:watch` - watch your current voice channel and auto-join when people enter. One voice channel can be active per server.',
      '`/giada voice mode:off` - disable watching for the active or selected voice channel.',
      '`/giada voice mode:join` - join your current voice channel now.',
      '`/giada status` - show current Discord settings.',
      '`/giada authorize user:@user` - allow a user to run Giada commands. Administrator or owner only.',
      '`/giada deauthorize user:@user` - remove command authorization. Administrator or owner only.'
    ].join('\n');
  }

  private statusText(guildId: string) {
    const settings = this.settings.get(guildId);
    const authorizedUsers = this.settings.listAuthorizedUsers(guildId);
    return [
      `Listening channels: ${settings.listeningChannelIds.length ? settings.listeningChannelIds.map((channelId) => `<#${channelId}>`).join(', ') : 'off'}`,
      `Voice watch channels: ${settings.voiceWatchChannelIds.length ? settings.voiceWatchChannelIds.map((channelId) => `<#${channelId}>`).join(', ') : 'off'}`,
      `Authorized command user IDs: ${authorizedUsers.length ? authorizedUsers.map((user) => user.userId).join(', ') : 'none'}`,
      `Owner bypass user ID: ${this.config.GIADA_OWNER_DISCORD_USER_ID ?? 'not configured'}`
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

  private hasHttpAdminOrOwner(payload: DiscordHttpInteraction) {
    const userId = payload.member?.user?.id ?? payload.user?.id;
    if (userId && this.isOwnerUser(userId)) {
      return true;
    }
    const permissions = payload.member?.permissions;
    if (!permissions) {
      return false;
    }
    try {
      return (BigInt(permissions) & PermissionFlagsBits.Administrator) === PermissionFlagsBits.Administrator;
    } catch {
      return false;
    }
  }

  private isOwnerUser(userId: string) {
    return Boolean(this.config.GIADA_OWNER_DISCORD_USER_ID && userId === this.config.GIADA_OWNER_DISCORD_USER_ID);
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

function hasBooleanNsfw(value: unknown): value is { nsfw: boolean } {
  return typeof value === 'object'
    && value !== null
    && 'nsfw' in value
    && typeof (value as { nsfw?: unknown }).nsfw === 'boolean';
}

function isVoiceTextChannelMessage(message: Message, voiceChannelId: string) {
  return message.channelId === voiceChannelId
    || getThreadParentId(message.channel) === voiceChannelId
    || getChannelParentId(message.channel) === voiceChannelId;
}

function voiceBridgeKey(guildId: string, channelId: string) {
  return `${guildId}:${channelId}`;
}

function parseVoiceBridgeKey(key: string) {
  const [guildId, channelId] = key.split(':');
  if (!guildId || !channelId) {
    return null;
  }
  return { guildId, channelId };
}

function getThreadParent(value: unknown) {
  if (!isThreadLikeChannel(value) || !value.isThread()) {
    return null;
  }
  return value.parent ?? null;
}

function getThreadParentId(value: unknown) {
  if (!isThreadLikeChannel(value) || !value.isThread()) {
    return null;
  }
  return typeof value.parentId === 'string' ? value.parentId : null;
}

function getChannelParentId(value: unknown) {
  if (typeof value !== 'object' || value === null || !('parentId' in value)) {
    return null;
  }
  return typeof (value as { parentId?: unknown }).parentId === 'string'
    ? (value as { parentId: string }).parentId
    : null;
}

function isThreadLikeChannel(value: unknown): value is { isThread: () => boolean; parent?: unknown; parentId?: unknown } {
  return typeof value === 'object'
    && value !== null
    && 'isThread' in value
    && typeof (value as { isThread?: unknown }).isThread === 'function';
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
  if (normalized && ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(normalized)) {
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
  if (lowerName.endsWith('.gif')) {
    return 'image/gif';
  }
  return null;
}

function clampContextText(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 700 ? `${normalized.slice(0, 697)}...` : normalized;
}

function clampDiscordMessage(text: string) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 1900 ? `${normalized.slice(0, 1897)}...` : normalized;
}

function allowedMentionsForContent(content: string) {
  const users = [...new Set([...content.matchAll(/<@!?(\d{5,25})>/g)].map((match) => match[1]).filter((id): id is string => Boolean(id)))];
  return {
    parse: [],
    users
  };
}

function isReplyFallbackError(error: unknown) {
  return isUnknownDiscordMessageReferenceError(error) || isDiscordSystemMessageReplyError(error);
}

function isUnknownDiscordMessageReferenceError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('MESSAGE_REFERENCE_UNKNOWN_MESSAGE') || message.includes('Unknown message');
}

function isDiscordSystemMessageReplyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('REPLIES_CANNOT_REPLY_TO_SYSTEM_MESSAGE') || message.includes('Cannot reply to a system message');
}

function isDiscordSendFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Missing Access')
    || message.includes('Missing Permissions')
    || message.includes('Cannot send messages')
    || message.includes('REPLIES_CANNOT_REPLY_TO_SYSTEM_MESSAGE')
    || message.includes('Cannot reply to a system message');
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

export async function registerDiscordCommands(config: AppConfig, activeApplicationId: string | null = null, guildIds: string[] = []) {
  const configuredApplicationId = config.DISCORD_APPLICATION_ID?.trim();
  if (configuredApplicationId && activeApplicationId && configuredApplicationId !== activeApplicationId) {
    logger.error('Refusing to register slash commands to a different application than the logged-in bot.', {
      configuredApplicationId,
      activeApplicationId
    });
    return { ok: false, error: 'application_id_mismatch' };
  }

  const applicationId = activeApplicationId ?? configuredApplicationId;
  const registrationToken = discordRegistrationToken(config);
  if (!applicationId || !registrationToken) {
    logger.error('Cannot register Discord commands: missing DISCORD_APPLICATION_ID or Discord authorization token');
    return { ok: false, error: 'missing_application_id_or_token' };
  }

  const rest = new REST({ version: '10' }).setToken(registrationToken);
  const commands = [giadaCommand.toJSON()];
  const targetGuildIds = config.DISCORD_GUILD_ID
    ? [config.DISCORD_GUILD_ID]
    : [...new Set(guildIds)];
  const registeredGuilds: string[] = [];

  for (const guildId of targetGuildIds) {
    try {
      const registered = await rest.put(
        Routes.applicationGuildCommands(applicationId, guildId),
        { body: commands }
      ) as DiscordRegisteredCommand[];
      registeredGuilds.push(guildId);
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

  let registeredGlobal = false;
  if (config.DISCORD_REGISTER_GLOBAL_COMMANDS) {
    try {
      const registered = await rest.put(
        Routes.applicationCommands(applicationId),
        { body: commands }
      ) as DiscordRegisteredCommand[];
      registeredGlobal = true;
      logger.info('Registered global Discord slash commands with REST route', {
        applicationId,
        commands: registered.map((command) => ({ id: command.id, name: command.name }))
      });
    } catch (error) {
      logger.error('Failed to register global Discord slash commands', error instanceof Error ? error.message : String(error));
    }
  }

  return { ok: true, applicationId, registeredGuilds, registeredGlobal };
}

function discordRegistrationToken(config: AppConfig) {
  const botToken = config.DISCORD_BOT_TOKEN?.trim();
  if (botToken) {
    return botToken;
  }
  const bearerToken = config.DISCORD_BEARER_TOKEN?.trim();
  if (bearerToken) {
    return bearerToken;
  }
  return null;
}

async function fetchRemoteAvatar(value: string, publicUrl: string) {
  const url = new URL(value);
  const isOwnOrigin = url.origin === new URL(publicUrl).origin;
  if (!isOwnOrigin && (url.protocol !== 'https:' || isPrivateHostname(url.hostname))) throw new Error('Avatar URL must use public HTTPS');
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
  const length = Number(response.headers.get('content-length') ?? 0);
  const type = response.headers.get('content-type') ?? '';
  if (!response.ok || !type.startsWith('image/') || length > 8 * 1024 * 1024) throw new Error('Invalid avatar response');
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > 8 * 1024 * 1024) throw new Error('Avatar must be at most 8 MiB');
  return data;
}

function isPrivateHostname(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.local') || normalized === '::1') return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31)
    || (parts[0] === 192 && parts[1] === 168);
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
