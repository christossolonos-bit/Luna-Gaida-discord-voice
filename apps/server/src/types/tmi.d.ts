declare module 'tmi.js' {
  export interface ChatUserstate {
    id?: string;
    'display-name'?: string;
    username?: string;
    'user-id'?: string;
    tmiSentTs?: string;
  }

  export interface ClientOptions {
    options?: { debug?: boolean };
    connection?: { reconnect?: boolean; secure?: boolean };
    identity?: { username: string; password: string };
    channels?: string[];
  }

  export class Client {
    constructor(options: ClientOptions);
    on(event: 'message', handler: (channel: string, tags: ChatUserstate, message: string, self: boolean) => void): void;
    on(event: 'connected', handler: (address: string, port: number) => void): void;
    connect(): Promise<[string, number]>;
    disconnect(): Promise<[string, number]>;
    say(channel: string, message: string): Promise<[string]>;
  }
}
