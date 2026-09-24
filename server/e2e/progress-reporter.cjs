/* global console, setInterval, clearInterval, module */

class ProgressReporter {
  constructor() {
    this.startedAt = new Map();
    this.watchdogs = new Map();
  }

  onBegin(_config, suite) {
    const count = suite.allTests().length;
    console.log(`[e2e] started: ${count} tests`);
  }

  onTestBegin(test) {
    const startedAt = Date.now();
    this.startedAt.set(test, startedAt);
    console.log(`[e2e] START ${test.titlePath().join(" > ")}`);

    const watchdog = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[e2e] STILL RUNNING ${elapsed}s ${test.titlePath().join(" > ")}`);
    }, 10_000);
    this.watchdogs.set(test, watchdog);
  }

  onTestEnd(test, result) {
    const startedAt = this.startedAt.get(test) ?? Date.now();
    const watchdog = this.watchdogs.get(test);
    if (watchdog !== undefined) {
      clearInterval(watchdog);
      this.watchdogs.delete(test);
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[e2e] ${result.status.toUpperCase()} ${elapsed}s ${test.titlePath().join(" > ")}`);
    this.startedAt.delete(test);
  }

  onEnd(result) {
    for (const watchdog of this.watchdogs.values()) {
      clearInterval(watchdog);
    }
    this.watchdogs.clear();
    console.log(`[e2e] finished: ${result.status}`);
  }
}

module.exports = ProgressReporter;
