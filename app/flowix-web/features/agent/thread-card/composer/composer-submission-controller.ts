import type { ComposerController } from "./composer-controller";
import type { ComposerImageController, AgentThreadCardInputImage } from "./composer-image-controller";
import {
  selectComposerSubmissionState,
  type ComposerRuntimeState,
  type ComposerSubmissionKind,
} from "./composer-submission-state";

export type ComposerSubmissionPhase = "idle" | "preparing" | "binding" | "accepting" | "accepted" | "failed";

export interface ComposerSubmissionSnapshot {
  markdown: string;
  prompt: string;
  images: AgentThreadCardInputImage[];
}

/** Input stays intact until acceptance; binding/IPC failures remain retryable. */
export class ComposerSubmissionController {
  phase: ComposerSubmissionPhase = "idle";
  snapshot: ComposerSubmissionSnapshot | null = null;

  get isSubmitting(): boolean {
    return this.phase === "preparing" || this.phase === "binding" || this.phase === "accepting";
  }

  async submit<T>(options: {
    composer: Pick<ComposerController, "getPrompt" | "getDraftMarkdown" | "flushPendingDraft" |
      "clearDraft" | "clear" | "resetHistoryNavigation" | "updateMultiLineState">;
    images: Pick<ComposerImageController, "hasImages" | "hasPending" | "readyImages" |
      "setLocked" | "clearAfterSubmit">;
    getRuntime: () => ComposerRuntimeState;
    isDisposed: () => boolean;
    bind: (snapshot: ComposerSubmissionSnapshot) => Promise<T>;
    accept: (bound: T, snapshot: ComposerSubmissionSnapshot, kind: ComposerSubmissionKind) => Promise<void>;
    clearPersistedDraft: () => void;
    onPhaseChange: () => void;
    onError: (error: unknown) => void;
  }): Promise<void> {
    const { composer, images } = options;
    const state = selectComposerSubmissionState({
      ...options.getRuntime(),
      isSubmitting: this.isSubmitting,
      prompt: composer.getPrompt(),
      hasAttachments: images.hasImages,
      hasPendingAttachments: images.hasPending,
    });
    if (options.isDisposed() || !state.canSubmit) return;

    const snapshot: ComposerSubmissionSnapshot = {
      markdown: composer.getDraftMarkdown(),
      prompt: composer.getPrompt().trim() || "Analyze the attached image(s).",
      images: images.readyImages.map((image) => ({ ...image })),
    };
    this.snapshot = snapshot;
    const transition = (phase: ComposerSubmissionPhase): void => {
      this.phase = phase;
      if (!options.isDisposed()) options.onPhaseChange();
    };
    transition("preparing");
    images.setLocked(true);
    try {
      composer.flushPendingDraft();
      transition("binding");
      const bound = await options.bind(snapshot);
      if (options.isDisposed()) return;
      transition("accepting");
      // Recheck thread work after asynchronous binding. A newly pending
      // command/stop must not turn a prepared request into an invalid send.
      if (!selectComposerSubmissionState({
        ...options.getRuntime(), isSubmitting: false,
        prompt: snapshot.prompt, hasAttachments: snapshot.images.length > 0,
        hasPendingAttachments: false, kind: state.kind,
      }).canSubmit) throw new Error("Agent is busy; please retry when the current operation finishes.");
      await options.accept(bound, snapshot, state.kind);
      if (options.isDisposed()) return;
      // Acceptance is irreversible. A subsequent UI cleanup error must
      // never describe the request as rejected and invite an unsafe retry.
      transition("accepted");
      if (composer.getDraftMarkdown() === snapshot.markdown) {
        composer.clearDraft();
        composer.clear();
        composer.resetHistoryNavigation();
        options.clearPersistedDraft();
      }
      images.clearAfterSubmit();
      this.snapshot = null;
    } catch (error) {
      if (this.phase !== "accepted") transition("failed");
      if (!options.isDisposed()) options.onError(error);
    } finally {
      // A disposed surface must not receive late callbacks or DOM writes.
      if (!options.isDisposed()) {
        images.setLocked(false);
        composer.updateMultiLineState();
      }
      if (this.isSubmitting) this.phase = "idle";
    }
  }
}
