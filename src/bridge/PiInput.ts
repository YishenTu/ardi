// Everything the user sends pi: messages, edits to pi's message queue, and
// Stop. Owns the order input reaches pi in, pi's queue as pi reports it,
// and what goes back to the message box.
//
// Ordering: input runs one step at a time, in the order asked, together
// with the session's own steps (start, switching session; `exclusive`), so
// a message reaches the session it was sent to and queue edits can't
// interleave. Stop doesn't wait its turn; input asked for before a stop and
// not yet sent goes back to the message box instead.
//
// pi's queue: pi holds queued messages as text, steering then follow-ups,
// and reports both lists whole in each queue_update: when one is added,
// when it takes one (the oldest with that text) and when the queue is
// cleared. It can't edit the queue in place, so steering, editing or
// removing one message clears the queue and sends the rest again. Its
// queue drops a taken message by text, so no message may have empty text:
// an image-only message is sent with a space.
//
// Known pi limitation: pi takes the next queued message out of its run's
// queue before it starts it (message_start), and may compact in between.
// Until then pi still lists it, and clear_queue returns it without being
// able to cancel it, so a steer, edit or remove in that window can't stop
// it: it's delivered anyway (and twice, if it was sent again). pi's RPC
// gives no way to tell.

import type { ImageAttachment, QueueAction, QueuedMessage } from "../chat";
import { restoreOf } from "../restore";
import type { BridgeEvent, SessionUpdate } from "./protocol";
import type { PiRPCTransport } from "./runtime/PiRPCTransport";

// A message as it can be sent (again).
type Message = { text: string; steer: boolean; images?: ImageAttachment[] };
type Cleared = { steering: string[]; followUp: string[] };
// Events PiInput sends the extension (the session labels queue and chunk).
type InputEvent = Extract<SessionUpdate, { type: "queue" | "chunk" }> | Extract<BridgeEvent, { type: "restore" | "prompt_result" }>;

export class PiInput {
  private transport: PiRPCTransport | null = null;
  private steps: Promise<void> = Promise.resolve();
  // Counts stops; a step remembers the count it was asked for at.
  private stops = 0;
  private queue = new QueueTracker();

  constructor(private readonly emit: (event: InputEvent) => void) {}

  // Input goes to `transport` from now on: call once pi is proven to be on
  // the requested session.
  connect(transport: PiRPCTransport): void {
    this.transport = transport;
  }

  // pi moved to another session: its queue there starts empty.
  reset(): void {
    this.queue = new QueueTracker();
  }

  // A session step, in order with input.
  exclusive(run: () => Promise<void>): Promise<void> {
    return this.step(run);
  }

  // pi starts a run with the message, or queues it while it works: to
  // take after its current step (`steer`) or once it's done. pi answers
  // with `prompt_result` if there's a `promptId`, and the chat shows the
  // message once pi starts it. Rejected, it goes back to the message box.
  prompt(text: string, { images, steer = false, promptId }: { images?: ImageAttachment[]; steer?: boolean; promptId?: string } = {}): Promise<void> {
    return this.step(async (stopped) => {
      if (!stopped()) return this.send({ text, images, steer }, promptId);
      if (promptId) this.emit({ type: "prompt_result", promptId, started: false });
      this.giveBack([{ text, images, steer }]);
    });
  }

  // Steer a queued message, take it back to the message box (`edit`), or
  // remove it.
  queueAction({ action, index, text }: QueueAction): Promise<void> {
    const change = (message: Message): Message[] => {
      if (action === "steer") return [{ ...message, steer: true }];
      if (action === "edit") this.giveBack([message]);
      return [];
    };
    return this.step((stopped) => this.requeue(index, text, stopped, change));
  }

  // Stops pi now. Its queued messages go back to the message box first: pi
  // would still run them after the stop.
  async stop(): Promise<void> {
    this.stops++;
    if (!this.transport) return;
    this.giveBack(await this.clear());
    await this.transport.request("abort").catch((error: unknown) => this.notice(error));
  }

  // Drops pi's queue without giving it back (the chat is being left).
  async discard(): Promise<void> {
    await this.clear();
  }

  observe(event: Record<string, unknown>): void {
    if (event.type === "queue_update") this.emit({ type: "queue", queue: this.queue.update(strings(event.steering), strings(event.followUp)) });
    // pi takes everything queued before it settles; anything left came in
    // as the run ended. After a stop it goes back to the box, otherwise it's
    // sent again, which starts a run for it.
    if (event.type === "agent_settled" && this.queue.list.length) {
      const aborted = event.aborted === true;
      void this.step(async (stopped) => {
        const left = await this.clear();
        if (aborted) this.giveBack(left);
        else await this.resend(left, stopped);
      });
    }
  }

  // Runs `run` after earlier steps; `stopped` tells whether a stop came
  // since it was asked for.
  private step(run: (stopped: () => boolean) => Promise<void>): Promise<void> {
    const stops = this.stops;
    const done = this.steps.then(() => run(() => this.stops !== stops));
    this.steps = done.catch(() => undefined);
    return done;
  }

  // Only a newly started run restores browser permission (`prompt_result`):
  // rejected, queued or handled input must not unlock browser calls from an
  // earlier run.
  private async send(message: Message, promptId?: string): Promise<void> {
    const text = message.text || (message.images?.length ? " " : "");
    const images = message.images?.map((image) => ({ type: "image", ...image }));
    this.queue.sending(message.images);
    // No timeout: pi answers a prompt that starts a run only once the run
    // is prepared (which can include compacting), and only its answer says
    // whether it will run. If pi dies first, the extension hands it back.
    const accepted = await this.transport?.request<{ disposition: string }>("prompt", { message: text, images, streamingBehavior: message.steer ? "steer" : "followUp" }, 0).catch((error: unknown) => {
      this.notice(error);
      this.giveBack([message]);
      return undefined;
    });
    this.queue.sending(null);
    if (promptId) this.emit({ type: "prompt_result", promptId, started: accepted?.disposition === "started" });
  }

  private async requeue(index: number, text: string, stopped: () => boolean, change: (message: Message) => Message[]): Promise<void> {
    // A stop already took the queue back.
    if (stopped() || find(this.queue.list, index, text) < 0) return;
    const cleared = await this.clear();
    // pi may have taken some while clearing; what it cleared is what's left.
    const at = find(cleared, index, text);
    await this.resend(at < 0 ? cleared : cleared.toSpliced(at, 1, ...change(cleared[at])), stopped);
  }

  // Sent as prompts, so they start a new run if the old one ended.
  private async resend(messages: Message[], stopped: () => boolean): Promise<void> {
    // Steering first, as pi delivers.
    const ordered = [...messages.filter((m) => m.steer), ...messages.filter((m) => !m.steer)];
    for (const [i, message] of ordered.entries()) {
      if (stopped()) return this.giveBack(ordered.slice(i));
      await this.send(message);
    }
  }

  // Clears pi's queue; returns what pi cleared.
  private async clear(): Promise<Message[]> {
    if (!this.queue.list.length || !this.transport) return [];
    // pi's answer can arrive after events that change what's tracked.
    const before = this.queue.snapshot();
    const cleared = await this.transport.request<Cleared>("clear_queue").catch(() => undefined);
    return cleared ? before.take(cleared) : [];
  }

  private giveBack(messages: Message[]): void {
    const restore = restoreOf(messages);
    if (restore) this.emit({ type: "restore", ...restore });
  }

  private notice(error: unknown): void {
    this.emit({ type: "chunk", chunk: { type: "notice", content: error instanceof Error ? error.message : String(error), level: "error" } });
  }
}

// pi's queue from its queue_update events, with the images of each queued
// message (pi's queue holds only text), per list and text, oldest first.
class QueueTracker {
  private steering: string[] = [];
  private followUp: string[] = [];
  private images = new Map<string, (ImageAttachment[] | undefined)[]>();
  // Images of the message being sent; the next text pi adds is it.
  private pending: ImageAttachment[] | undefined | null = null;

  get list(): QueuedMessage[] {
    return asList(this.steering, this.followUp);
  }

  sending(images: ImageAttachment[] | undefined | null): void {
    this.pending = images;
  }

  update(steering: string[], followUp: string[]): QueuedMessage[] {
    this.track(true, this.steering, steering);
    this.track(false, this.followUp, followUp);
    this.steering = steering;
    this.followUp = followUp;
    return this.list;
  }

  // The images as they are now, to match against what clear_queue answers.
  snapshot(): { take(cleared: Cleared): Message[] } {
    const images = new Map([...this.images].map(([k, list]) => [k, [...list]]));
    return {
      take(cleared) {
        const left = asList(cleared.steering, cleared.followUp);
        // pi takes the oldest of equal texts first, so what it cleared is the newest.
        const pools = new Map<string, (ImageAttachment[] | undefined)[]>();
        for (const [k, n] of count(left.map((message) => key(message.steer, message.text)))) {
          const known = (images.get(k) ?? []).slice(-n);
          pools.set(k, [...Array<undefined>(n - known.length).fill(undefined), ...known]);
        }
        return left.map((message) => ({ ...message, images: pools.get(key(message.steer, message.text))!.shift() }));
      },
    };
  }

  // A text pi added is the message being sent; one it removed is the
  // oldest with that text.
  private track(steer: boolean, before: string[], after: string[]): void {
    const was = count(before);
    const now = count(after);
    for (const text of new Set([...was.keys(), ...now.keys()])) {
      const k = key(steer, text);
      const pool = this.images.get(k) ?? [];
      const change = (now.get(text) ?? 0) - (was.get(text) ?? 0);
      if (change < 0) pool.splice(0, -change);
      if (change > 0 && this.pending !== null) {
        pool.push(this.pending);
        this.pending = null;
      }
      if (pool.length) this.images.set(k, pool);
      else this.images.delete(k);
    }
  }
}

const key = (steer: boolean, text: string) => `${steer ? "s" : "f"}:${text}`;

// The place of the message named by `index` and `text`; the text decides,
// the place breaks ties between equal texts.
function find(list: { text: string }[], index: number, text: string): number {
  return list[index]?.text === text ? index : list.findIndex((message) => message.text === text);
}

function asList(steering: string[], followUp: string[]): QueuedMessage[] {
  return [...steering.map((text) => ({ text, steer: true })), ...followUp.map((text) => ({ text, steer: false }))];
}

function count(texts: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
  return counts;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
