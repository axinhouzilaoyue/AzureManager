import { DurableObject } from "cloudflare:workers";
import { jsonResponse } from "../lib/utils";

interface LockState {
  owner: string;
  expiresAt: number;
}

export class SubscriptionLock extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/acquire") {
      const body = (await request.json()) as {
        owner: string;
        ttlSeconds?: number;
      };
      return this.handleAcquire(body.owner, body.ttlSeconds ?? 900);
    }

    if (request.method === "POST" && url.pathname === "/release") {
      const body = (await request.json()) as {
        owner: string;
      };
      return this.handleRelease(body.owner);
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const state = await this.ctx.storage.get<LockState>("state");
      return jsonResponse({
        state,
      });
    }

    return jsonResponse(
      {
        error: "not_found",
      },
      { status: 404 },
    );
  }

  private async handleAcquire(owner: string, ttlSeconds: number): Promise<Response> {
    const now = Date.now();
    const current = await this.ctx.storage.get<LockState>("state");

    if (!current || current.expiresAt <= now || current.owner === owner) {
      const nextState: LockState = {
        owner,
        expiresAt: now + ttlSeconds * 1000,
      };
      await this.ctx.storage.put("state", nextState);
      return jsonResponse({
        acquired: true,
        owner,
        expiresAt: nextState.expiresAt,
      });
    }

    return jsonResponse(
      {
        acquired: false,
        owner: current.owner,
        expiresAt: current.expiresAt,
      },
      { status: 409 },
    );
  }

  private async handleRelease(owner: string): Promise<Response> {
    const current = await this.ctx.storage.get<LockState>("state");
    if (!current || current.owner !== owner) {
      return jsonResponse({
        released: false,
      });
    }

    await this.ctx.storage.delete("state");
    return jsonResponse({
      released: true,
    });
  }
}
