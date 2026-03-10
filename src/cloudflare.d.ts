declare module "cloudflare:workers" {
  export interface WorkflowEvent<TPayload = unknown> {
    payload: TPayload;
  }

  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
  }

  interface DurableObjectStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put<T = unknown>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
  }

  interface DurableObjectState {
    storage: DurableObjectStorage;
  }

  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }

  export abstract class WorkflowEntrypoint<Env = unknown> {
    protected env: Env;
    constructor(ctx: unknown, env: Env);
    abstract run(event: Readonly<WorkflowEvent<unknown>>, step: WorkflowStep): Promise<unknown>;
  }
}
