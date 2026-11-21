/* PY TRAINN — Python execution worker.
   Runs CPython (Pyodide/WASM) inside a Web Worker: no DOM, no server, no real
   filesystem access and no network APIs exposed to the user's code. */

let pyodide = null;
const PYODIDE_VERSION = '0.26.4';
const CDN = 'https://cdn.jsdelivr.net/pyodide/v' + PYODIDE_VERSION + '/full/';

const DRIVER = `
import io, json, contextlib, traceback

def _load(code):
    ns = {'__name__': '__main__'}
    buf = io.StringIO()
    err = None
    with contextlib.redirect_stdout(buf):
        try:
            exec(compile(code, '<your code>', 'exec'), ns)
        except BaseException as exc:
            err = ''.join(traceback.format_exception_only(type(exc), exc)).strip()
    return ns, buf.getvalue(), err

def _eval_test(ns, test):
    try:
        if test.get('stdout'):
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                eval(compile(test['expr'], '<test>', 'eval'), ns)
            return buf.getvalue().strip()
        val = eval(compile(test['expr'], '<test>', 'eval'), ns)
        return repr(val)
    except BaseException as exc:
        return 'ERROR: ' + ''.join(traceback.format_exception_only(type(exc), exc)).strip()

def run_submission(code, solution, tests_json):
    tests = json.loads(tests_json)
    ref_ns, _, ref_err = _load(solution)
    if ref_err:
        return json.dumps({'stdout': '', 'error': 'reference solution failed: ' + ref_err, 'tests': []})
    expected = [_eval_test(ref_ns, t) for t in tests]
    ns, out, err = _load(code)
    results = []
    for test, exp in zip(tests, expected):
        if err:
            results.append({'label': test['label'], 'pass': False, 'got': 'not run - code raised an error', 'expected': exp})
            continue
        got = _eval_test(ns, test)
        results.append({'label': test['label'], 'pass': got == exp, 'got': got, 'expected': exp})
    return json.dumps({'stdout': out, 'error': err, 'tests': results})
`;

self.onmessage = async (event) => {
  const msg = event.data || {};

  if (msg.type === 'boot') {
    try {
      importScripts(CDN + 'pyodide.js');
      pyodide = await loadPyodide({ indexURL: CDN });
      pyodide.runPython(DRIVER);
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'boot-error', error: String(err && err.message ? err.message : err) });
    }
    return;
  }

  if (msg.type === 'run') {
    if (!pyodide) {
      self.postMessage({ type: 'result', id: msg.id, error: 'Python engine is not ready.', stdout: '', tests: [] });
      return;
    }
    try {
      const runner = pyodide.globals.get('run_submission');
      const raw = runner(msg.code, msg.solution, JSON.stringify(msg.tests));
      const parsed = JSON.parse(raw);
      runner.destroy && runner.destroy();
      self.postMessage({ type: 'result', id: msg.id, stdout: parsed.stdout, error: parsed.error, tests: parsed.tests });
    } catch (err) {
      self.postMessage({ type: 'result', id: msg.id, error: String(err), stdout: '', tests: [] });
    }
  }
};
