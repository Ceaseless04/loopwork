import { describe, expect, it } from "vitest";
import { validateFlow } from "../../src/validate.js";
import type { Edge, Flow, FlowNode } from "../../src/types.js";

// GM-2/GM-4, E_CYCLE: a directed cycle among a scope's nodes. One error per scope with a cycle, path = the scope pointer,
// message `cycle: a -> b -> a` (scoped ids, first cycle found). A body cycle is not re-reported at the outer scope.

const str = { type: "string" } as const;
const map: FlowNode = { kind: "map", fn: "f", in: str, out: str };
const e = (from: string, to: string): Edge => ({
  from: { node: from, port: "out" },
  to: { node: to, port: "in" },
});
const frame = (
  nodes: Record<string, FlowNode>,
  edges: Edge[],
  entry: string,
  exit: string,
): FlowNode => ({
  kind: "frame",
  frame: "while",
  body: {
    nodes,
    edges,
    entry: { node: entry, port: "in" },
    exit: { node: exit, port: "out" },
  },
  budgets: { maxIterations: 10, maxDurationMs: 1000 },
  condition: "c",
  in: str,
  out: str,
});
const flow = (nodes: Record<string, FlowNode>, edges: Edge[]): Flow => ({
  version: 1,
  id: "f",
  name: "f",
  nodes,
  edges,
});

const cycles = (f: Flow) => {
  const r = validateFlow(f);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.errors.map((x) => [x.code, x.path, x.message, x.node]);
};

describe("GM-4: E_CYCLE", () => {
  const rows: [string, Flow, string, string, string][] = [
    [
      "a cycle in the outer graph yields E_CYCLE",
      flow({ a: map, b: map }, [e("a", "b"), e("b", "a")]),
      "",
      "cycle: a -> b -> a",
      "a",
    ],
    [
      "a cycle in a body yields E_CYCLE",
      flow(
        { f: frame({ x: map, y: map }, [e("x", "y"), e("y", "x")], "x", "y") },
        [],
      ),
      "/nodes/f/body",
      "cycle: f.x -> f.y -> f.x",
      "f.x",
    ],
    [
      "a cycle across a nested frame's body yields E_CYCLE",
      flow(
        {
          f: frame(
            {
              g: frame(
                { x: map, y: map },
                [e("x", "y"), e("y", "x")],
                "x",
                "y",
              ),
            },
            [],
            "g",
            "g",
          ),
        },
        [],
      ),
      "/nodes/f/body/nodes/g/body",
      "cycle: f.g.x -> f.g.y -> f.g.x",
      "f.g.x",
    ],
  ];

  it.each(rows)("GM-4: %s", (_name, f, path, message, node) => {
    expect(cycles(f)).toEqual([["E_CYCLE", path, message, node]]);
  });

  it("GM-4: the same topology expressed with a frame validates", () => {
    // a -> b -> a as a back-edge fails; the loop as a while frame (body a -> b) has no back-edge and passes.
    expect(
      validateFlow(flow({ a: map, b: map }, [e("a", "b"), e("b", "a")])).ok,
    ).toBe(false);
    expect(
      validateFlow(
        flow({ f: frame({ a: map, b: map }, [e("a", "b")], "a", "b") }, []),
      ).ok,
    ).toBe(true);
  });

  it("GM-4: a 200k-node chain does not overflow the stack and is valid", () => {
    const n = 200_000;
    const nodes: Record<string, FlowNode> = {};
    const edges: Edge[] = [];
    for (let i = 0; i < n; i++) {
      nodes[`n${i}`] = map;
      if (i > 0) edges.push(e(`n${i - 1}`, `n${i}`));
    }
    expect(validateFlow(flow(nodes, edges)).ok).toBe(true);
  });
});

describe("GM-2: E_CYCLE", () => {
  it("GM-2: E_CYCLE a self-loop edge is a cycle", () => {
    expect(cycles(flow({ a: map }, [e("a", "a")]))).toEqual([
      ["E_CYCLE", "", "cycle: a -> a", "a"],
    ]);
  });

  it("GM-2: E_CYCLE a body cycle is not reported again at the outer scope", () => {
    const f = flow({ f: frame({ x: map }, [e("x", "x")], "x", "x") }, []);
    expect(cycles(f).map((x) => x[1])).toEqual(["/nodes/f/body"]);
  });

  it("GM-2: E_CYCLE a lead-in node is not part of the reported cycle", () => {
    expect(
      cycles(
        flow({ r: map, a: map, b: map }, [
          e("r", "a"),
          e("a", "b"),
          e("b", "a"),
        ]),
      ).map((x) => x[2]),
    ).toEqual(["cycle: a -> b -> a"]);
  });

  it("GM-2: E_CYCLE a node with several out-edges still finds the cycle", () => {
    expect(
      cycles(
        flow({ a: map, s: map, b: map }, [
          e("a", "s"),
          e("a", "b"),
          e("b", "a"),
        ]),
      ).map((x) => x[2]),
    ).toEqual(["cycle: a -> b -> a"]);
  });

  it("GM-2: E_CYCLE cycles in two scopes report one error each", () => {
    const f = flow(
      { a: map, b: map, f: frame({ x: map }, [e("x", "x")], "x", "x") },
      [e("a", "b"), e("b", "a")],
    );
    expect(cycles(f).map((x) => [x[0], x[1]])).toEqual([
      ["E_CYCLE", ""],
      ["E_CYCLE", "/nodes/f/body"],
    ]);
  });
});
