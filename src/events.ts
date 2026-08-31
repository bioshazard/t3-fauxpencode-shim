import type { FacadeEvent } from "./types.ts";

type EventListener = (event: FacadeEvent) => void;

function frame(event: FacadeEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export class EventHub {
  private readonly listeners = new Map<number, EventListener>();
  private nextListenerId = 1;

  publish(event: FacadeEvent): void {
    for (const listener of this.listeners.values()) listener(event);
  }

  subscribe(listener: EventListener): () => void {
    const id = this.nextListenerId;
    this.nextListenerId += 1;
    this.listeners.set(id, listener);
    return () => this.listeners.delete(id);
  }

  response(sessionID?: string): Response {
    const encoder = new TextEncoder();
    let unsubscribe = (): void => undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(encoder.encode(": connected\n\n"));
        unsubscribe = this.subscribe((event) => {
          if (sessionID !== undefined && event.sessionID !== sessionID) return;
          controller.enqueue(encoder.encode(frame(event)));
        });
      },
      cancel: () => unsubscribe(),
    });
    return new Response(stream, {
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
      },
    });
  }
}
