"use client"

import { useEffect, useRef, useState, useCallback } from "react"
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from "d3-force"
import type { GraphData } from "@/types/gbrain"
import { Button } from "@/components/ui/button"
import { Maximize2, Minimize2, ZoomIn, ZoomOut, RotateCcw } from "lucide-react"

interface SimNode extends SimulationNodeDatum {
  slug: string
  title: string
  type: string
  tags: string[]
  weight: number
  file?: string | null
  page_slug?: string | null
  start_line?: number | null
  end_line?: number | null
}

interface SimLink extends SimulationLinkDatum<SimNode> {
  type: string
}

interface GraphViewerProps {
  data: GraphData
  onNodeClick?: (node: SimNode) => void
  selectedSlug?: string | null
  initialTransform?: { x: number; y: number; k: number }
  onTransformChange?: (transform: { x: number; y: number; k: number }) => void
}

const typeColors: Record<string, string> = {
  concept: "#3b82f6",
  project: "#22c55e",
  decision: "#f59e0b",
  note: "#6b7280",
  function: "#2563eb",
  method: "#2563eb",
  class: "#16a34a",
  struct: "#16a34a",
  enum: "#d97706",
  type: "#d97706",
  unresolved: "#94a3b8",
  symbol: "#64748b",
  default: "#a855f7",
}

const typeLabels: Record<string, string> = {
  concept: "概念",
  project: "项目",
  decision: "决策",
  note: "笔记",
  function: "函数",
  method: "方法",
  class: "类",
  struct: "结构体",
  enum: "枚举",
  type: "类型",
  unresolved: "未解析符号",
  symbol: "符号",
  default: "未分类",
}

export function GraphViewer({ data, onNodeClick, selectedSlug, initialTransform, onTransformChange }: GraphViewerProps & { initialTransform?: { x: number; y: number; k: number }; onTransformChange?: (transform: { x: number; y: number; k: number }) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 })
  const [transform, setTransform] = useState(initialTransform ?? { x: 0, y: 0, k: 1 })
  const [hoveredNode, setHoveredNode] = useState<SimNode | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [renderNodes, setRenderNodes] = useState<SimNode[]>([])
  const [renderLinks, setRenderLinks] = useState<SimLink[]>([])
  const simRef = useRef<ReturnType<typeof forceSimulation<SimNode>> | null>(null)
  const nodesRef = useRef<SimNode[]>([])
  const linksRef = useRef<SimLink[]>([])

  // Measure container
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        setDimensions({ width: Math.max(width, 400), height: Math.max(height, 400) })
      }
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  // Build simulation when data changes
  useEffect(() => {
    simRef.current?.stop()

    const slugs = new Set(data.nodes.map((n) => n.slug))

    const nodes: SimNode[] = data.nodes.map((n) => ({
      slug: n.slug,
      title: n.title || n.slug,
      type: n.type || "default",
      tags: n.tags || [],
      weight: n.weight || 1,
      file: n.file,
      page_slug: n.page_slug,
      start_line: n.start_line,
      end_line: n.end_line,
    }))

    const links: SimLink[] = data.edges
      .filter((e) => slugs.has(e.source) && slugs.has(e.target))
      .map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type || "link",
      }))

    nodesRef.current = nodes
    linksRef.current = links
    /* eslint-disable react-hooks/set-state-in-effect -- synchronize D3 data with React-rendered SVG */
    setRenderNodes(nodes)
    setRenderLinks(links)
    /* eslint-enable react-hooks/set-state-in-effect */

    if (nodes.length === 0) return

    const centerX = dimensions.width / 2
    const centerY = dimensions.height / 2

    const simulation = forceSimulation<SimNode>(nodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(links)
          .id((d) => d.slug)
          .distance(80)
          .strength(0.4)
      )
      .force("charge", forceManyBody().strength(-200))
      .force("center", forceCenter(centerX, centerY))
      .force("collide", forceCollide(20))
      .alphaDecay(0.02)
      .on("tick", ticked)

    simRef.current = simulation

    function ticked() {
      const svg = svgRef.current
      if (!svg) return

      // Update links
      const linkElements = svg.querySelectorAll<SVGLineElement>(".graph-link")
      links.forEach((link, i) => {
        const el = linkElements[i]
        if (el && link.source && link.target) {
          const s = link.source as unknown as SimNode
          const t = link.target as unknown as SimNode
          if (s.x != null && s.y != null && t.x != null && t.y != null) {
            el.setAttribute("x1", String(s.x))
            el.setAttribute("y1", String(s.y))
            el.setAttribute("x2", String(t.x))
            el.setAttribute("y2", String(t.y))
          }
        }
      })

      // Update nodes
      const nodeElements = svg.querySelectorAll<SVGGElement>(".graph-node")
      nodes.forEach((node, i) => {
        const el = nodeElements[i]
        if (el && node.x != null && node.y != null) {
          el.setAttribute("transform", `translate(${node.x},${node.y})`)
        }
      })
    }

    return () => {
      simulation.stop()
    }
  }, [data, dimensions.width, dimensions.height])

  const ZOOM_MIN = 0.2
  const ZOOM_MAX = 5
  const MAX_WHEEL_DELTA = 0.25
  const transformRef = useRef(transform)

  const zoomAtPoint = useCallback((pointX: number, pointY: number, factor: number) => {
    setTransform((current) => {
      const nextScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, current.k * factor))
      const scaleRatio = nextScale / current.k
      // Keep the graph coordinate currently under the pointer fixed:
      // screen = translate + graph * scale.
      const nextTransform = {
        k: nextScale,
        x: pointX - (pointX - current.x) * scaleRatio,
        y: pointY - (pointY - current.y) * scaleRatio,
      }
      transformRef.current = nextTransform
      return nextTransform
    })
  }, [])

  // Toolbar zoom has no pointer location, so use the viewport center.
  const zoomAtViewportCenter = (factor: number) => {
    zoomAtPoint(dimensions.width / 2, dimensions.height / 2, factor)
  }

  const handleZoomIn = () => {
    zoomAtViewportCenter(1.3)
  }
  const handleZoomOut = () => {
    zoomAtViewportCenter(1 / 1.3)
  }
  const handleReset = () => {
    const nextTransform = { x: 0, y: 0, k: 1 }
    transformRef.current = nextTransform
    setTransform(nextTransform)
  }

  // Pointer-based pan works consistently for mouse, touch, and pen input.
  // The small movement threshold prevents a click from turning into a pan.
  const isPanning = useRef(false)
  const activePointerId = useRef<number | null>(null)
  const panStart = useRef({ x: 0, y: 0 })
  const panOrigin = useRef({ x: 0, y: 0 })
  const suppressClick = useRef(false)

  const handlePointerDown = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if ((e.target as Element).closest(".graph-node")) return
    isPanning.current = true
    activePointerId.current = e.pointerId
    suppressClick.current = false
    panStart.current = { x: e.clientX, y: e.clientY }
    panOrigin.current = { x: transformRef.current.x, y: transformRef.current.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const handlePointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (!isPanning.current || activePointerId.current !== e.pointerId) return
    const dx = e.clientX - panStart.current.x
    const dy = e.clientY - panStart.current.y
    if (Math.hypot(dx, dy) > 4) suppressClick.current = true
    const nextTransform = {
      ...transformRef.current,
      x: panOrigin.current.x + dx,
      y: panOrigin.current.y + dy,
    }
    transformRef.current = nextTransform
    setTransform(nextTransform)
  }, [])

  const handlePointerEnd = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    if (activePointerId.current === e.pointerId) {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      activePointerId.current = null
      isPanning.current = false
    }
  }, [])

  // Install a non-passive native listener. React's delegated wheel listener
  // cannot reliably prevent browser page zoom/scroll for trackpad gestures.
  // This follows XYFlow/vis-network: stop the event at the graph boundary,
  // normalize deltaMode, and keep the pointer location fixed during zoom.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const rect = svg.getBoundingClientRect()
      const pointX = event.clientX - rect.left
      const pointY = event.clientY - rect.top
      const modeFactor = event.deltaMode === 1 ? 0.05 : event.deltaMode === 2 ? 1 : 0.002
      const platform = typeof navigator !== "undefined" ? navigator.platform : ""
      const pinchFactor = event.ctrlKey && /Mac|iPhone|iPad/i.test(platform) ? 10 : 1
      const rawDelta = -event.deltaY * modeFactor * pinchFactor
      const delta = Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, rawDelta))
      zoomAtPoint(pointX, pointY, Math.exp(delta))
    }
    svg.addEventListener("wheel", onWheel, { passive: false })
    return () => svg.removeEventListener("wheel", onWheel)
  }, [zoomAtPoint])

  // Node radius based on weight
  const nodeRadius = (node: SimNode) => {
    // Weight range should give 6-20px radius
    const base = Math.max(6, Math.min(20, 6 + node.weight * 2))
    return base
  }

  return (
    <div
      ref={containerRef}
      className={`relative rounded-lg border border-border bg-card overflow-hidden ${
        isFullscreen ? "fixed inset-4 z-50" : "w-full h-[600px]"
      }`}
    >
      {/* Toolbar */}
      <div className="absolute top-3 right-3 z-10 flex gap-1">
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={handleZoomIn} title="放大">
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={handleZoomOut} title="缩小">
          <ZoomOut className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={handleReset} title="重置">
          <RotateCcw className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          onClick={() => setIsFullscreen(!isFullscreen)}
          title={isFullscreen ? "退出全屏" : "全屏"}
        >
          {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </Button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 z-10 bg-card/90 backdrop-blur-sm rounded-lg border border-border p-2 text-xs space-y-1">
        {Object.entries(typeLabels).map(([type, label]) => (
          <div key={type} className="flex items-center gap-2">
            <span
              className="w-3 h-3 rounded-full"
              style={{ backgroundColor: typeColors[type] || typeColors.default }}
            />
            <span className="text-muted-foreground">{label}</span>
          </div>
        ))}
        <div className="text-muted-foreground pt-1 border-t border-border mt-1">
          {data.nodes.length} 节点 · {data.edges.length} 边
        </div>
      </div>

      {/* Hover tooltip */}
      {hoveredNode && (
        <div className="absolute top-3 left-3 z-10 bg-card/95 backdrop-blur-sm rounded-lg border border-border p-3 shadow-lg max-w-xs">
          <p className="font-medium text-sm">{hoveredNode.title}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{hoveredNode.file || hoveredNode.slug}</p>
          {hoveredNode.start_line != null && (
            <p className="text-xs text-muted-foreground">行 {hoveredNode.start_line}{hoveredNode.end_line != null ? `-${hoveredNode.end_line}` : ""}</p>
          )}
          <div className="flex items-center gap-2 mt-2">
            <span
              className="w-2 h-2 rounded-full"
              style={{ backgroundColor: typeColors[hoveredNode.type] || typeColors.default }}
            />
            <span className="text-xs text-muted-foreground">
              {typeLabels[hoveredNode.type] || hoveredNode.type}
            </span>
          </div>
        </div>
      )}

      {/* SVG Graph */}
      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        style={{ touchAction: "none" }}
        className="cursor-grab active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
      >
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {/* Links */}
          {renderLinks.map((link, i) => (
            <line
              key={`link-${i}`}
              className="graph-link"
              stroke="#64748b"
              strokeWidth={2.5}
              strokeOpacity={0.85}
            />
          ))}
          {/* Nodes */}
          {renderNodes.map((node) => {
            const r = nodeRadius(node)
            const isSelected = node.slug === selectedSlug
            const color = typeColors[node.type] || typeColors.default

            return (
              <g
                key={node.slug}
                className="graph-node"
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setHoveredNode(node)}
                onMouseLeave={() => setHoveredNode(null)}
                onClick={() => {
                  if (!suppressClick.current) onNodeClick?.(node)
                  suppressClick.current = false
                }}
              >
                {/* Glow for selected */}
                {isSelected && (
                  <circle r={r + 6} fill={color} opacity={0.15} />
                )}
                {/* Main circle */}
                <circle
                  r={r}
                  fill={color}
                  stroke={isSelected ? "#fff" : "transparent"}
                  strokeWidth={isSelected ? 2 : 0}
                  opacity={isSelected ? 1 : 0.85}
                />
                {/* Label for larger nodes */}
                {r > 10 && (
                  <text
                    dy={r + 14}
                    textAnchor="middle"
                    fill="hsl(var(--muted-foreground))"
                    fontSize="10"
                    className="pointer-events-none"
                  >
                    {node.title.length > 12 ? node.title.slice(0, 12) + "..." : node.title}
                  </text>
                )}
              </g>
            )
          })}
        </g>
      </svg>
    </div>
  )
}
