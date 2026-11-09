"""Bounded fault injection for a Python module on a disposable copy of a repo (ntv-test § 3, § 5).

Collects AST mutation points in --module (comparison swap, and/or swap, dropped `not`, int + 1,
negated `if`, `return x` -> `return None`), keeps those on lines --diff changed (all lines without
--diff), samples --n of them with a fixed seed, applies one at a time, runs --tests with pytest and
restores the file. Each mutant is killed, survived, invalid (does not compile) or timeout.

Never run it on a working tree: it rewrites the module in place while it runs, and restores it.

    python3 -I mutate.py <copy> <out.json> --module pkg/mod.py --tests tests/test_mod.py [--diff change.diff]
"""
import argparse, ast, copy, json, random, re, subprocess, sys, time
from pathlib import Path

SWAP = {ast.Eq: ast.NotEq, ast.NotEq: ast.Eq, ast.Lt: ast.GtE, ast.GtE: ast.Lt, ast.Gt: ast.LtE,
        ast.LtE: ast.Gt, ast.In: ast.NotIn, ast.NotIn: ast.In, ast.Is: ast.IsNot, ast.IsNot: ast.Is}


def changed_lines(diff_text, module):
    """New-side line numbers of `module` that a `git diff -U0` touched."""
    lines, current = set(), None
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            current = line[4:].removeprefix("b/")
        elif line.startswith("@@") and current == module:
            m = re.search(r"\+(\d+)(?:,(\d+))?", line)
            start, count = int(m.group(1)), int(m.group(2) or 1)
            lines.update(range(start, start + count))
    return lines


def points(tree):
    pts = []
    for node in ast.walk(tree):
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


def run_tests(root, python, tests, timeout):
    t0 = time.time()
    try:
        r = subprocess.run([python, "-m", "pytest", "-x", "-q", "-p", "no:cacheprovider", *tests], cwd=root,
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return "timeout", timeout
    return {0: "survived", 1: "killed"}.get(r.returncode, f"pytest exit {r.returncode}"), round(time.time() - t0, 1)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", type=Path, help="disposable copy of the repo")
    ap.add_argument("out", type=Path, help="JSON results")
    ap.add_argument("--module", required=True, help="module path relative to root")
    ap.add_argument("--tests", nargs="+", required=True, help="test files relative to root")
    ap.add_argument("--diff", type=Path, help="`git diff -U0` output: mutate only the lines it changed")
    ap.add_argument("--n", type=int, default=40)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--timeout", type=int, default=90, help="seconds per test run")
    ap.add_argument("--python", default=sys.executable, help="interpreter with the repo's dependencies")
    a = ap.parse_args()

    if (a.root / ".git").exists():
        sys.exit(f"{a.root} is a git checkout: run on a copy (git archive HEAD | tar -x -C <dir>)")
    path = a.root / a.module
    original = path.read_text()
    tree = ast.parse(original)
    run = lambda: run_tests(a.root, a.python, a.tests, a.timeout)
    results = {"module": a.module, "tests": a.tests, "mutants": []}
    try:
        # The module is rewritten through ast.unparse: it must still pass as rewritten, else the
        # rewrite alone changes behaviour and no result means anything.
        path.write_text(ast.unparse(tree))
        base, _ = run()
        if base != "survived":
            sys.exit(f"baseline: the tests do not pass on the unmutated module ({base})")
        pts = points(tree)
        if a.diff:
            keep = changed_lines(a.diff.read_text(), a.module)
            pts = [p for p in pts if p[1].lineno in keep]
        random.Random(a.seed).shuffle(pts)
        walk = list(ast.walk(tree))
        src_lines = original.splitlines()
        for kind, node, idx in pts[: a.n]:
            tree2 = copy.deepcopy(tree)
            target = list(ast.walk(tree2))[walk.index(node)]
            entry = {"line": node.lineno, "kind": kind, "code": src_lines[node.lineno - 1].strip()[:160]}
            try:
                src = ast.unparse(ast.fix_missing_locations(Apply(target, kind, idx).visit(tree2)))
                compile(src, a.module, "exec")
            except Exception:
                results["mutants"].append({**entry, "result": "invalid"})
                continue
            path.write_text(src)
            entry["result"], entry["secs"] = run()
            results["mutants"].append(entry)
    finally:
        path.write_text(original)
    a.out.write_text(json.dumps(results, ensure_ascii=False, indent=1))
    rs = [m["result"] for m in results["mutants"]]
    print(f"{a.module}: {rs.count('killed')} killed, {rs.count('survived')} survived of {len(rs)} mutants")
    for m in results["mutants"]:
        if m["result"] == "survived":
            print(f"  survived line {m['line']} {m['kind']}: {m['code']}")


if __name__ == "__main__":
    main()
