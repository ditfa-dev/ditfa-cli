/**
 * Minimal stand-in for the `vscode` module.
 *
 * The extension host only injects the real module at runtime, so unit tests
 * alias this in its place (see vitest.config.ts). It implements exactly the
 * surface the modules under test touch — nothing more, so a test that starts
 * relying on new API fails loudly instead of silently passing against a mock.
 */

export interface Disposable {
  dispose(): void;
}

type Listener<T> = (value: T) => void;

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): Disposable => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}
