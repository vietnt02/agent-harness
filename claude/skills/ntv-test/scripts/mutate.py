"""Bounded fault injection for a Python module on a disposable copy of a repo (ntv-test § 3, § 5).

Collects AST mutation points in --module (comparison swap, and/or swap, dropped `not`, int + 1,
negated `if`, `return x` -> `return None`), keeps those on lines --diff changed (all lines without
--diff), samples --n of them with a fixed seed, applies one at a time, runs --tests with pytest and
restores the file. Each mutant is killed, survived, invalid (does not compile) or timeout; with
--confirm-tests, a survivor is rerun on those (the whole suite) and one they kill is
killed_elsewhere: covered, no gap.

Refuses a git working tree, a module outside the copy, a copy left mutated by an earlier run, and
tests that do not import the module from the copy. Runs for minutes: start it in the background.

    python3 -I mutate.py <copy> <out.json> --module pkg/mod.py --tests tests/test_mod.py \
        [--diff change.diff] [--confirm-tests tests/] [--python <repo interpreter>]
"""
import argparse, ast, copy, json, os, random, re, signal, subprocess, sys, time
from pathlib import Path

SWAP = {ast.Eq: ast.NotEq, ast.NotEq: ast.Eq, ast.Lt: ast.GtE, ast.GtE: ast.Lt, ast.Gt: ast.LtE,
        ast.LtE: ast.Gt, ast.In: ast.NotIn, ast.NotIn: ast.In, ast.Is: ast.IsNot, ast.IsNot: ast.Is}
# Runs that differ from the baseline only by the mutant must not reuse a cached .pyc: CPython trusts
# one whose source has the same size and whole-second mtime, which a same-size mutant often has.
ENV = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}


def unquote(path):
    """A git path as printed in a diff header: C-quoted when it holds non-ASCII or specials."""
    path = path.split("\t")[0]
    if path.startswith('"') and path.endswith('"'):
        path = path[1:-1].encode("latin-1", "backslashreplace").decode("unicode_escape").encode("latin-1").decode()
    return path


def changed_lines(diff_text, module):
    """New-side lines of `module` that a `git diff -U0 --src-prefix=a/ --dst-prefix=b/` touched."""
    lines, current, prev = set(), None, ""
    for line in diff_text.splitlines():
        if line.startswith("+++ ") and prev.startswith("--- "):
            current = unquote(line[4:])
            current = current[2:] if current.startswith("b/") else None
        elif line.startswith("@@") and current == module:
            m = re.match(r"@@ -\S+ \+(\d+)(?:,(\d+))? @@", line)
            start, count = int(m.group(1)), int(m.group(2) or 1)
            lines.update(range(start, start + count))
        prev = line
    return lines


def is_guard(node):
    """`if __name__ == "__main__":` and `if TYPE_CHECKING:`: mutating them only breaks collection."""
    t = node.test
    if isinstance(t, ast.Name) and t.id == "TYPE_CHECKING":
        return True
    if isinstance(t, ast.Attribute) and t.attr == "TYPE_CHECKING":
        return True
    return isinstance(t, ast.Compare) and isinstance(t.left, ast.Name) and t.left.id == "__name__"


def points(tree):
    skip = {id(n) for n in ast.walk(tree) if isinstance(n, ast.If) and is_guard(n)}
    skip |= {id(n) for g in ast.walk(tree) if isinstance(g, ast.If) and is_guard(g) for n in ast.walk(g.test)}
    pts = []
    for node in ast.walk(tree):
        if id(node) in skip:
            continue
        if isinstance(node, ast.Compare):
            pts += [("compare", node, i) for i, op in enumerate(node.ops) if type(op) in SWAP]
        elif isinstance(node, ast.BoolOp):
            pts.append(("boolop", node, None))
        elif isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            pts.append(("drop_not", node, None))
        elif isinstance(node, ast.Constant) and type(node.value) is int:
            pts.append(("int_plus1", node, None))
        elif isinstance(node, ast.If):
            pts.append(("if_negate", node, None))
        elif isinstance(node, ast.Return) and node.value is not None:
            pts.append(("return_none", node, None))
    return [p for p in pts if hasattr(p[1], "lineno")]


class Apply(ast.NodeTransformer):
    def __init__(self, target, kind, idx):
        self.target, self.kind, self.idx = target, kind, idx

    def generic_visit(self, node):
        node = super().generic_visit(node)
        if node is not self.target:
            return node
        if self.kind == "compare":
            node.ops[self.idx] = SWAP[type(node.ops[self.idx])]()
        elif self.kind == "boolop":
            node.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()
        elif self.kind == "drop_not":
            return node.operand
        elif self.kind == "int_plus1":
            node.value += 1
        elif self.kind == "if_negate":
            node.test = ast.UnaryOp(op=ast.Not(), operand=node.test)
        elif self.kind == "return_none":
            node.value = ast.Constant(None)
        return node


def run_tests(root, python, tests, timeout, module_path):
    for pyc in (module_path.parent / "__pycache__").glob(f"{module_path.stem}.*.pyc"):
        pyc.unlink()
    t0 = time.time()
    p = subprocess.Popen([python, "-m", "pytest", "-x", "-q", "-p", "no:cacheprovider", *tests], cwd=root,
                         env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        rc = p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(p.pid, signal.SIGKILL)  # the tests' own servers and workers too
        p.wait()
        return "timeout", timeout
    # 1: a test failed; 2: collection failed, which the clean baseline rules out as a cause.
    return {0: "survived", 1: "killed", 2: "killed"}.get(rc, f"pytest exit {rc}"), round(time.time() - t0, 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", type=Path, help="disposable copy of the repo")
    ap.add_argument("out", type=Path, help="JSON results")
    ap.add_argument("--module", required=True, help="module path relative to root")
    ap.add_argument("--tests", nargs="+", required=True, help="test files relative to root")
    ap.add_argument("--confirm-tests", nargs="+", help="wider tests (the suite) each survivor is rerun on")
    ap.add_argument("--diff", type=Path, help="`git diff -U0` output: mutate only the lines it changed")
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--timeout", type=int, default=90, help="seconds per test run")
    ap.add_argument("--python", default=sys.executable, help="interpreter with the repo's dependencies")
    a = ap.parse_args()

    root = a.root.resolve()
    inside = subprocess.run(["git", "-C", str(root), "rev-parse", "--is-inside-work-tree"],
                            capture_output=True, text=True).stdout.strip()
    if inside == "true":
        sys.exit(f"{root} is inside a git working tree: run on a copy (git archive <sha> | tar -x -C <dir>)")
    path = (root / a.module).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        sys.exit(f"--module {a.module} is not a file inside {root}")
    sentinel = path.with_name(path.name + ".mutate-orig")
    if sentinel.exists():
        sys.exit(f"{sentinel} exists: an earlier run was stopped mid-mutant; make a fresh copy")
    original = path.read_text()
    tree = ast.parse(original)
    pts = points(tree)
    if a.diff:
        keep = changed_lines(a.diff.read_text(), a.module)
        if not keep:
            sys.exit(f"--diff touches no line of {a.module}: check the path and the diff's a/ b/ prefixes")
        pts = [p for p in pts if p[1].lineno in keep]
    run = lambda tests: run_tests(root, a.python, tests, a.timeout, path)

    sentinel.write_text(original)
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda *_: sys.exit(1))  # through finally: the module is restored
    results = {"module": a.module, "tests": a.tests, "mutants": []}
    try:
        # The module is rewritten through ast.unparse: it must still pass as rewritten, else the
        # rewrite alone changes behaviour and no result means anything.
        path.write_text(ast.unparse(tree))
        base, _ = run(a.tests)
        if base != "survived":
            sys.exit(f"baseline: the tests do not pass on the unmutated module ({base.replace('killed', 'failed')})")
        # A wider suite that already fails would turn every survivor into killed_elsewhere.
        if a.confirm_tests and run(a.confirm_tests)[0] != "survived":
            sys.exit("baseline: --confirm-tests do not pass on the unmutated module: narrow them to a passing set")
        # Tests that import the module from elsewhere (an installed copy, PYTHONPATH) pass whatever
        # the copy holds: every mutant would "survive".
        path.write_text('raise RuntimeError("mutate canary")\n')
        if run(a.tests)[0] == "survived":
            sys.exit(f"the tests do not import {a.module} from {root}")
        random.Random(a.seed).shuffle(pts)
        walk = list(ast.walk(tree))
        src_lines = original.splitlines()
        for kind, node, idx in pts[: a.n]:
            tree2 = copy.deepcopy(tree)
            target = list(ast.walk(tree2))[walk.index(node)]
            entry = {"line": node.lineno, "kind": kind, "code": src_lines[node.lineno - 1].strip()[:160]}
            src = ast.unparse(ast.fix_missing_locations(Apply(target, kind, idx).visit(tree2)))
            try:
                compile(src, a.module, "exec")
            except (SyntaxError, ValueError):
                results["mutants"].append({**entry, "result": "invalid"})
                continue
            path.write_text(src)
            entry["result"], entry["secs"] = run(a.tests)
            if entry["result"] == "survived" and a.confirm_tests and run(a.confirm_tests)[0] == "killed":
                entry["result"] = "killed_elsewhere"
            results["mutants"].append(entry)
    finally:
        path.write_text(original)
        sentinel.unlink()
    a.out.write_text(json.dumps(results, ensure_ascii=False, indent=1))
    counts = {}
    for m in results["mutants"]:
        counts[m["result"]] = counts.get(m["result"], 0) + 1
    print(f"{a.module}: {len(results['mutants'])} mutants: " + ", ".join(f"{v} {k}" for k, v in sorted(counts.items())))
    for m in results["mutants"]:
        if m["result"] == "survived":
            print(f"  survived line {m['line']} {m['kind']}: {m['code']}")


if __name__ == "__main__":
    main()
