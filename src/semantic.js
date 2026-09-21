// The page never posts clinical text to a network endpoint. This worker runs the model locally.
export class LocalInterpreter {
  constructor({ onStatus, onResult, onError, model }) {
    this.handlers = { onStatus, onResult, onError };
    this.worker = null;
    this.id = 0;
    this.model = model;
  }
  ensure() {
    if (this.worker) return;
    this.worker = new Worker(
      new URL("./semantic-worker.js?v=1.2.0", import.meta.url),
      {
        type: "module",
      },
    );
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === "status" && (m.id === undefined || m.id === this.id))
        this.handlers.onStatus(m);
      if (m.type === "result" && m.id === this.id) this.handlers.onResult(m);
      if (m.type === "error" && m.id === this.id) this.handlers.onError(m);
    };
    this.worker.onerror = (e) =>
      this.handlers.onError({
        message: e.message || "Local model failed to start.",
      });
  }
  analyze(note, catalog, candidates = []) {
    this.ensure();
    const id = ++this.id;
    this.worker.postMessage({
      type: "analyze",
      id,
      note,
      catalog,
      candidates,
      model: this.model,
    });
    return id;
  }
  cancel() {
    this.id++;
    this.worker?.postMessage({ type: "cancel" });
  }
  pause() {
    this.id++;
    this.worker?.terminate();
    this.worker = null;
  }
  restart() {
    this.pause();
  }
}
window.FolioInterpreter = LocalInterpreter;
window.dispatchEvent(new Event("folio:interpreter-ready"));
