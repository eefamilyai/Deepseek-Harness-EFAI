/**
 * The page-inspection scripts behind the `eval` and `console` actions.
 *
 * A rendering bug is answered by the page, not by its text projection: the
 * model has to read a value out of the running page (`renderer.info.render`,
 * a uniform, a transform) and has to see what the page's own JavaScript threw.
 * Neither is visible in a text snapshot, so both are exposed here as scripts
 * that run in the page and come back as JSON.
 *
 * Every builder returns the JSON *text* of its result, and every driver parses
 * it. The headless driver could return the value directly, but a page can hold
 * `undefined`, functions, DOM nodes, `BigInt`, and cycles, none of which cross
 * the wire intact; taking JSON text on both surfaces means one serialization
 * rule instead of two that disagree.
 *
 * @module @deepseek-ai/dsh-web-browser/inspect
 */

/** One captured console line. `level` is the console method or an error event. */
export interface ConsoleEntry {
  /** `log`, `info`, `warn`, `error`, `debug`, `uncaught`, or `unhandledrejection`. */
  readonly level: string
  /** The joined arguments, already stringified for the model. */
  readonly text: string
  /** Milliseconds since the epoch, as the page's clock reported it. */
  readonly at: number
  /** Source location for an error event, when the browser supplied one. */
  readonly where?: string
}

/** What one `console` read returns. */
export interface ConsoleRead {
  /**
   * Whether the recorder is installed in this page at all.
   *
   * False means nothing has been recorded yet — either the page has not been
   * navigated since the browser started, or that surface cannot install a
   * recorder before the page's own scripts run. It is deliberately distinct
   * from an installed recorder that happens to hold no entries: those are
   * opposite facts about whether a silent page is really silent.
   */
  readonly recording: boolean
  /** Entries recorded since the previous read. */
  readonly entries: readonly ConsoleEntry[]
  /** Entries the recorder dropped because the buffer was full. */
  readonly dropped: number
}

/** The result of evaluating model-supplied JavaScript in the page. */
export interface EvalResult {
  /** Whether the script ran without throwing. */
  readonly ok: boolean
  /** The JSON-friendly rendering of the completion value, when it returned. */
  readonly value?: string
  /** The thrown error's message and stack, when it did not. */
  readonly error?: string
}

/**
 * The recorder installed into a page before its own scripts run.
 *
 * Idempotent, because both drivers install it more than once: the headless
 * driver at page creation and the sidebar driver on every navigation. A page
 * that reloads loses it, which is why installation travels with navigation
 * rather than with browser launch.
 *
 * The buffer is bounded and keeps the NEWEST entries: a runaway `console.log`
 * loop must not turn into unbounded memory in the operator's own page.
 * @returns a JS expression that installs the recorder and yields true.
 */
export function installConsoleScript(): string {
  return `(() => {
    var VERSION = 1;
    if (window.__dshConsole && window.__dshConsole.version === VERSION) return true;
    var CAP = 500;
    var state = { version: VERSION, entries: [], dropped: 0, cursor: 0 };
    var stringify = function (value) {
      try {
        if (typeof value === 'string') return value;
        if (value instanceof Error) return value.stack || (value.name + ': ' + value.message);
        if (typeof value === 'undefined') return 'undefined';
        if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
        var json = JSON.stringify(value);
        return typeof json === 'undefined' ? String(value) : json;
      } catch (error) { return String(value); }
    };
    var push = function (level, text, where) {
      var entry = { level: level, text: String(text).slice(0, 4000), at: Date.now() };
      if (where) entry.where = where;
      state.entries.push(entry);
      if (state.entries.length > CAP) {
        var overflow = state.entries.length - CAP;
        state.entries.splice(0, overflow);
        state.cursor = Math.max(0, state.cursor - overflow);
        state.dropped += overflow;
      }
    };
    var levels = ['log', 'info', 'warn', 'error', 'debug'];
    for (var index = 0; index < levels.length; index += 1) {
      (function (level) {
        var original = console[level];
        console[level] = function () {
          var parts = [];
          for (var i = 0; i < arguments.length; i += 1) parts.push(stringify(arguments[i]));
          push(level, parts.join(' '));
          if (typeof original === 'function') return original.apply(console, arguments);
        };
      })(levels[index]);
    }
    window.addEventListener('error', function (event) {
      var where = event.filename ? event.filename + ':' + event.lineno + ':' + event.colno : undefined;
      var message = event.message || (event.error && event.error.message) || 'Script error';
      push('uncaught', message, where);
    });
    window.addEventListener('unhandledrejection', function (event) {
      var reason = event.reason;
      var message = reason && reason.stack ? reason.stack : stringify(reason);
      push('unhandledrejection', message);
    });
    window.__dshConsole = state;
    return true;
  })()`
}

/**
 * The script that returns the entries recorded since the previous read.
 *
 * Reading advances a cursor instead of emptying the buffer, so a second call
 * during the same page life reports what is new and still leaves the history
 * that a later question may need.
 * @returns a JS expression yielding the {@link ConsoleRead} as JSON text.
 */
export function readConsoleScript(): string {
  return `(() => {
    var state = window.__dshConsole;
    if (!state) return JSON.stringify({ recording: false, entries: [], dropped: 0 });
    var entries = state.entries.slice(state.cursor);
    state.cursor = state.entries.length;
    return JSON.stringify({ recording: true, entries: entries, dropped: state.dropped });
  })()`
}

/**
 * The script that evaluates model-supplied JavaScript in the page.
 *
 * The code is `eval`uated rather than pasted into a function body: the model
 * writes both expressions (`renderer.info.render.triangles`) and statements
 * (`const a = 1; return a`), and `eval` handles each without the harness having
 * to guess which it received. A returned promise is awaited, because a page
 * whose state settles asynchronously is the normal case for a rendering task.
 *
 * The completion value is JSON-serialized with cycles, `BigInt`, functions, and
 * DOM nodes made printable instead of throwing: the alternative is a TypeError
 * from `JSON.stringify` masquerading as a bug in the model's own script.
 * @param code - the JavaScript the model sent.
 * @returns a JS expression yielding the {@link EvalResult} as JSON text.
 */
export function evalScript(code: string): string {
  return `(async () => {
    var seen = [];
    var printable = function (value) {
      if (typeof value === 'undefined') return '[undefined]';
      if (typeof value === 'bigint') return value.toString() + 'n';
      if (typeof value === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
      if (typeof value === 'symbol') return value.toString();
      if (value instanceof Element) return '<' + value.tagName.toLowerCase() + '>';
      return value;
    };
    try {
      var result = await eval(${JSON.stringify(code)});
      var json;
      try {
        json = JSON.stringify(result, function (key, value) {
          var flattened = printable(value);
          if (flattened !== value) return flattened;
          if (typeof value === 'object' && value !== null) {
            if (seen.indexOf(value) !== -1) return '[Circular]';
            seen.push(value);
          }
          return value;
        }, 2);
      } catch (serialization) {
        json = String(result);
      }
      return JSON.stringify({ ok: true, value: typeof json === 'undefined' ? '[undefined]' : json });
    } catch (error) {
      var detail = error && error.stack ? error.stack : String(error);
      return JSON.stringify({ ok: false, error: String(detail) });
    }
  })()`
}

/**
 * Format one `eval` result for the transcript.
 * @param result - the parsed page result.
 * @returns the text the model reads.
 */
export function formatEvalResult(result: EvalResult): string {
  if (!result.ok) return `SCRIPT ERROR: ${result.error ?? 'the page threw without a message'}`
  const value = result.value ?? '[undefined]'
  return value.length === 0 ? 'RESULT: (the script produced an empty string)' : `RESULT:\n${value}`
}

/**
 * Format one console read for the transcript.
 * @param read - what the page reported.
 * @returns the text the model reads.
 */
export function formatConsoleRead(read: ConsoleRead): string {
  if (!read.recording) {
    return 'CONSOLE: no recorder is installed in this page yet — navigate (or read) first, then'
      + ' act; errors thrown before the first navigation on the sidebar surface are not captured.'
  }
  if (read.entries.length === 0) {
    const dropped = read.dropped === 0 ? '' : ` (${String(read.dropped)} older entries were dropped)`
    return `CONSOLE: no new messages${dropped}.`
  }
  const lines = read.entries.map((entry) => {
    const where = entry.where === undefined ? '' : ` (${entry.where})`
    return `[${entry.level}] ${entry.text}${where}`
  })
  const dropped = read.dropped === 0 ? '' : `\n(${String(read.dropped)} older entries were dropped)`
  return `CONSOLE (${String(read.entries.length)} new):\n${lines.join('\n')}${dropped}`
}
