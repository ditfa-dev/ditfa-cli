import { DitfaOptions } from "./ditfaOptions";
import { DitfaExec } from "./exec";
import { Thread } from "./thread";
import { ThreadOptions } from "./threadOptions";

/**
 * Ditfa is the main class for interacting with the Ditfa agent.
 *
 * Use the `startThread()` method to start a new thread or `resumeThread()` to resume a previously started thread.
 */
export class Ditfa {
  private exec: DitfaExec;
  private options: DitfaOptions;

  constructor(options: DitfaOptions = {}) {
    const { ditfaPathOverride, env, config } = options;
    this.exec = new DitfaExec(ditfaPathOverride, env, config);
    this.options = options;
  }

  /**
   * Starts a new conversation with an agent.
   * @returns A new thread instance.
   */
  startThread(options: ThreadOptions = {}): Thread {
    return new Thread(this.exec, this.options, options);
  }

  /**
   * Resumes a conversation with an agent based on the thread id.
   * Threads are persisted in ~/.ditfa/sessions.
   *
   * @param id The id of the thread to resume.
   * @returns A new thread instance.
   */
  resumeThread(id: string, options: ThreadOptions = {}): Thread {
    return new Thread(this.exec, this.options, options, id);
  }
}
