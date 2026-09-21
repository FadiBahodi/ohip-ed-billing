const test = require("node:test");
const assert = require("node:assert/strict");
test("edited notes discard stale model results; pause releases the worker; retry starts fresh", async () => {
  const savedWindow = global.window,
    savedWorker = global.Worker;
  global.window = new EventTarget();
  const workers = [];
  global.Worker = class {
    constructor() {
      this.messages = [];
      workers.push(this);
    }
    postMessage(m) {
      this.messages.push(m);
    }
    terminate() {
      this.terminated = true;
    }
    deliver(m) {
      this.onmessage({ data: m });
    }
  };
  try {
    const { LocalInterpreter } = await import("../src/semantic.js");
    const results = [],
      errors = [];
    const bridge = new LocalInterpreter({
      onStatus: () => {},
      onResult: (m) => results.push(m),
      onError: (m) => errors.push(m),
    });
    const first = bridge.analyze("old encounter", []);
    bridge.cancel();
    const second = bridge.analyze("new encounter", []);
    workers[0].deliver({
      type: "result",
      id: first,
      interpretation: { old: true },
    });
    workers[0].deliver({ type: "error", id: first, message: "old failure" });
    assert.equal(results.length, 0);
    assert.equal(errors.length, 0);
    workers[0].deliver({
      type: "result",
      id: second,
      interpretation: { current: true },
    });
    assert.equal(results.length, 1);
    bridge.pause();
    assert.equal(workers[0].terminated, true);
    const third = bridge.analyze("restarted encounter", []);
    assert.equal(workers.length, 2);
    assert(third > second);
    workers[0].deliver({ type: "result", id: second });
    assert.equal(results.length, 1);
    bridge.restart();
    assert.equal(workers[1].terminated, true);
  } finally {
    global.window = savedWindow;
    global.Worker = savedWorker;
  }
});
