declare module "@urbit/http-api" {
  export class Urbit {
    url: string;
    code: string;
    ship?: string | null;
    nodeId?: string;
    cookie?: string;

    connect(): Promise<void>;
    getShipName(): Promise<void>;
    getOurName(): Promise<void>;
    poke(params: { app: string; mark: string; json: unknown }): Promise<unknown>;
    delete(): Promise<void>;

    static authenticate(params: {
      ship: string;
      code: string;
      desk?: string;
      url: string;
      verbose?: boolean;
    }): Promise<Urbit>;
  }
}
