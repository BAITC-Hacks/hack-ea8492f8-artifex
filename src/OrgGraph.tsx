import { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, MarkerType, Position, type Node, type Edge } from '@xyflow/react';
import dagre from '@dagrejs/dagre';
import type { NormalizedSnapshot } from '../shared/schema';
import '@xyflow/react/dist/style.css';

export default function OrgGraph({
  snapshot,
  onSelect,
  oversight,
}: {
  snapshot: NormalizedSnapshot;
  onSelect: (id: string) => void;
  oversight: boolean;
}) {
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 700px)');
    const update = () => setCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const { nodes, edges } = useMemo(() => {
    const width = compact ? 140 : 190,
      height = compact ? 104 : 84;
    const counts = new Map<string, number>();
    for (const fn of snapshot.functions) counts.set(fn.departmentId, (counts.get(fn.departmentId) ?? 0) + 1);
    const layout = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
    layout.setGraph({
      rankdir: compact ? 'LR' : 'TB',
      nodesep: compact ? 12 : 32,
      ranksep: compact ? 24 : 72,
      marginx: 15,
      marginy: 15,
    });
    snapshot.departments.forEach((d) => layout.setNode(d.id, { width, height }));
    const edgeMap = new Map<string, Edge>();
    for (const d of snapshot.departments)
      if (d.parentId)
        edgeMap.set(`${d.parentId}-${d.id}`, {
          id: `parent-${d.id}`,
          source: d.parentId,
          target: d.id,
          type: 'smoothstep',
          style: { stroke: '#a3b1a8', strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#a3b1a8' },
        });
    for (const r of snapshot.relationships) {
      if (r.type === 'part_of' || r.type === 'member_of') continue;
      if (r.type === 'reports_to')
        edgeMap.set(`${r.toId}-${r.fromId}`, {
          id: r.id,
          source: r.toId,
          target: r.fromId,
          type: 'smoothstep',
          style: { stroke: '#a3b1a8', strokeWidth: 1.5 },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#a3b1a8' },
        });
      else if (oversight)
        edgeMap.set(r.id, {
          id: r.id,
          source: r.fromId,
          target: r.toId,
          label: r.type,
          type: 'smoothstep',
          style: { stroke: '#bc7a33', strokeDasharray: '5 4' },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#bc7a33' },
        });
    }
    for (const edge of edgeMap.values()) if (!edge.label) layout.setEdge(edge.source, edge.target);
    dagre.layout(layout);
    const nodes: Node[] = snapshot.departments.map((d) => ({
      id: d.id,
      position: { x: layout.node(d.id).x - width / 2, y: layout.node(d.id).y - height / 2 },
      sourcePosition: compact ? Position.Right : Position.Bottom,
      targetPosition: compact ? Position.Left : Position.Top,
      data: {
        label: (
          <div className={`org-node ${compact ? 'compact' : ''}`}>
            <strong title={d.name}>{d.name}</strong>
            <span>
              {d.kind ? `${d.kind} · ` : ''}
              {counts.get(d.id) ?? 0} {counts.get(d.id) === 1 ? 'function' : 'functions'}
            </span>
          </div>
        ),
      },
      style: { width, height },
    }));
    return { nodes, edges: [...edgeMap.values()] };
  }, [snapshot, oversight, compact]);
  return (
    <ReactFlow
      key={`${snapshot.id}-${compact}`}
      nodes={nodes}
      edges={edges}
      fitView
      minZoom={0.2}
      maxZoom={1.8}
      nodesDraggable={false}
      nodesConnectable={false}
      onNodeClick={(_e, node) => onSelect(node.id)}
    >
      <Background color="#dfe5df" gap={22} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
