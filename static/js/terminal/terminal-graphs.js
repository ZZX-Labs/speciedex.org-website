/*
========================================================================
Speciedex.org
Terminal Graphs Renderer
========================================================================

Structured graph renderer for SpeciedexTerminal.

Provides:

    • Node and edge normalization
    • Accessible SVG graph rendering
    • Circular, layered, and grid layouts
    • Directed and undirected graphs
    • Adjacency-table output
    • Safe terminal renderer integration
    • Command-based graph generation

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Graphs";
    const VERSION = "2.1.0";

    const RENDERER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.graphs.renderer"
        );

    const INSTANCE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.graphs.instance"
        );

    const SVG_NS =
        "http://www.w3.org/2000/svg";

    const DEFAULT_WIDTH = 960;
    const DEFAULT_HEIGHT = 560;
    const DEFAULT_NODE_RADIUS = 18;
    const MIN_DIMENSION = 240;
    const MAX_DIMENSION = 4096;
    const DEFAULT_MAX_NODES = 5000;
    const DEFAULT_MAX_EDGES = 25000;
    const DEFAULT_METADATA_DEPTH = 12;

    function dispatch(target, name, detail, options = {}) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function"
        ) {
            return false;
        }

        try {
            return target.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        bubbles:
                            options.bubbles === true,
                        cancelable:
                            options.cancelable === true,
                        detail
                    }
                )
            );
        } catch (_error) {
            return false;
        }
    }

    function clone(
        value,
        seen =
            new WeakMap(),
        depth =
            0
    ) {
        if (
            value ===
                null ||
            value ===
                undefined ||
            typeof value !==
                "object"
        ) {
            return value;
        }

        if (
            depth >
            DEFAULT_METADATA_DEPTH
        ) {
            return "[Truncated]";
        }

        if (
            typeof structuredClone ===
                "function"
        ) {
            try {
                return structuredClone(
                    value
                );
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (
            seen.has(
                value
            )
        ) {
            return seen.get(
                value
            );
        }

        if (
            value instanceof
                Date
        ) {
            return new Date(
                value.getTime()
            );
        }

        if (
            Array.isArray(
                value
            )
        ) {
            const output =
                [];

            seen.set(
                value,
                output
            );

            for (
                const item of
                value
            ) {
                output.push(
                    clone(
                        item,
                        seen,
                        depth +
                            1
                    )
                );
            }

            return output;
        }

        const output =
            {};

        seen.set(
            value,
            output
        );

        for (
            const [
                key,
                item
            ] of Object.entries(
                value
            )
        ) {
            if (
                [
                    "__proto__",
                    "prototype",
                    "constructor"
                ].includes(
                    key
                )
            ) {
                continue;
            }

            output[
                key
            ] =
                clone(
                    item,
                    seen,
                    depth +
                        1
                );
        }

        return output;
    }

    function isElement(
        value
    ) {
        return Boolean(
            value &&
            value.nodeType ===
                1 &&
            typeof value.querySelector ===
                "function"
        );
    }

    function clampNumber(value, fallback, minimum, maximum) {
        const parsed = Number(value);

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(minimum, parsed)
        );
    }

    function safeString(value, fallback = "") {
        if (
            value === null ||
            value === undefined
        ) {
            return fallback;
        }

        return String(value);
    }

    function createSVGElement(name, attributes = {}) {
        const element =
            document.createElementNS(
                SVG_NS,
                name
            );

        for (
            const [key, value] of
            Object.entries(attributes)
        ) {
            if (
                value !== undefined &&
                value !== null
            ) {
                element.setAttribute(
                    key,
                    String(value)
                );
            }
        }

        return element;
    }

    function normalizeNode(node, index) {
        if (
            node === null ||
            node === undefined
        ) {
            return {
                id: `node-${index + 1}`,
                label: `Node ${index + 1}`,
                value: null,
                group: null,
                metadata: {}
            };
        }

        if (
            typeof node === "string" ||
            typeof node === "number"
        ) {
            const value =
                String(node);

            return {
                id: value,
                label: value,
                value: node,
                group: null,
                metadata: {}
            };
        }

        const id =
            safeString(
                node.id ??
                node.key ??
                node.name ??
                node.label ??
                `node-${index + 1}`
            );

        return {
            id,
            label:
                safeString(
                    node.label ??
                    node.name ??
                    id
                ),
            value:
                node.value ?? null,
            group:
                node.group ?? null,
            metadata:
                node.metadata &&
                typeof node.metadata === "object"
                    ? clone(
                        node.metadata
                    )
                    : {},
            x:
                Number.isFinite(
                    Number(node.x)
                )
                    ? Number(node.x)
                    : null,
            y:
                Number.isFinite(
                    Number(node.y)
                )
                    ? Number(node.y)
                    : null
        };
    }

    function normalizeEdge(edge, index) {
        if (Array.isArray(edge)) {
            return {
                id: `edge-${index + 1}`,
                source:
                    safeString(edge[0]),
                target:
                    safeString(edge[1]),
                label:
                    edge[2] === undefined
                        ? ""
                        : safeString(edge[2]),
                value:
                    edge[3] ?? null,
                directed: true,
                metadata: {}
            };
        }

        if (
            edge &&
            typeof edge === "object"
        ) {
            return {
                id:
                    safeString(
                        edge.id ??
                        `edge-${index + 1}`
                    ),
                source:
                    safeString(
                        edge.source ??
                        edge.from
                    ),
                target:
                    safeString(
                        edge.target ??
                        edge.to
                    ),
                label:
                    safeString(
                        edge.label ??
                        edge.name ??
                        ""
                    ),
                value:
                    edge.value ??
                    edge.weight ??
                    null,
                directed:
                    edge.directed !== false,
                metadata:
                    edge.metadata &&
                    typeof edge.metadata === "object"
                        ? clone(
                            edge.metadata
                        )
                        : {}
            };
        }

        throw new TypeError(
            `Invalid graph edge at index ${index}.`
        );
    }

    function parseEdgeString(value) {
        const text =
            safeString(value).trim();

        const directedMatch =
            text.match(
                /^(.+?)\s*(?:->|→)\s*(.+?)(?:\s*:\s*(.+))?$/
            );

        if (directedMatch) {
            return {
                source:
                    directedMatch[1].trim(),
                target:
                    directedMatch[2].trim(),
                label:
                    directedMatch[3]?.trim() || "",
                directed: true
            };
        }

        const undirectedMatch =
            text.match(
                /^(.+?)\s*(?:--|-|—)\s*(.+?)(?:\s*:\s*(.+))?$/
            );

        if (undirectedMatch) {
            return {
                source:
                    undirectedMatch[1].trim(),
                target:
                    undirectedMatch[2].trim(),
                label:
                    undirectedMatch[3]?.trim() || "",
                directed: false
            };
        }

        return null;
    }

    function normalizeGraph(
        data,
        options =
            {}
    ) {
        const maxNodes =
            clampNumber(
                options.maxNodes,
                DEFAULT_MAX_NODES,
                1,
                100000
            );

        const maxEdges =
            clampNumber(
                options.maxEdges,
                DEFAULT_MAX_EDGES,
                0,
                1000000
            );
        if (typeof data === "string") {
            const trimmed =
                data.trim();

            if (!trimmed) {
                return {
                    nodes: [],
                    edges: []
                };
            }

            try {
                return normalizeGraph(
                    JSON.parse(trimmed),
                    options
                );
            } catch (_error) {
                const edges =
                    trimmed
                        .split(/\r?\n|,/)
                        .map(item =>
                            parseEdgeString(item)
                        )
                        .filter(Boolean);

                return normalizeGraph(
                    {
                        edges
                    },
                    options
                );
            }
        }

        if (Array.isArray(data)) {
            const looksLikeEdges =
                data.every(item =>
                    Array.isArray(item) ||
                    (
                        item &&
                        typeof item === "object" &&
                        (
                            "source" in item ||
                            "from" in item
                        ) &&
                        (
                            "target" in item ||
                            "to" in item
                        )
                    ) ||
                    (
                        typeof item === "string" &&
                        Boolean(
                            parseEdgeString(item)
                        )
                    )
                );

            return looksLikeEdges
                ? normalizeGraph(
                    {
                        edges:
                            data
                    },
                    options
                )
                : normalizeGraph(
                    {
                        nodes:
                            data,
                        edges:
                            []
                    },
                    options
                );
        }

        const source =
            data &&
            typeof data === "object"
                ? data
                : {};

        const rawEdges =
            Array.isArray(source.edges)
                ? source.edges
                : [];

        const normalizedEdges =
            rawEdges
                .slice(
                    0,
                    maxEdges
                )
                .map((edge, index) => {
                    if (
                        typeof edge ===
                        "string"
                    ) {
                        return (
                            parseEdgeString(edge) ||
                            normalizeEdge(
                                {
                                    source: edge,
                                    target: ""
                                },
                                index
                            )
                        );
                    }

                    return normalizeEdge(
                        edge,
                        index
                    );
                })
                .filter(edge =>
                    edge.source &&
                    edge.target
                );

        const nodeMap = new Map();

        const rawNodes =
            Array.isArray(source.nodes)
                ? source.nodes.slice(
                    0,
                    maxNodes
                )
                : [];

        for (
            const [
                index,
                rawNode
            ] of rawNodes.entries()
        ) {
            const node =
                normalizeNode(
                    rawNode,
                    index
                );

            const requestedID =
                node.id;

            let uniqueID =
                requestedID;

            let duplicate =
                2;

            while (
                nodeMap.has(
                    uniqueID
                )
            ) {
                uniqueID =
                    `${requestedID}:${duplicate}`;

                duplicate +=
                    1;
            }

            node.id =
                uniqueID;

            nodeMap.set(
                uniqueID,
                node
            );
        }

        for (
            const edge of
            normalizedEdges
        ) {
            if (
                !nodeMap.has(edge.source) &&
                nodeMap.size <
                    maxNodes
            ) {
                nodeMap.set(
                    edge.source,
                    normalizeNode(
                        edge.source,
                        nodeMap.size
                    )
                );
            }

            if (
                !nodeMap.has(edge.target) &&
                nodeMap.size <
                    maxNodes
            ) {
                nodeMap.set(
                    edge.target,
                    normalizeNode(
                        edge.target,
                        nodeMap.size
                    )
                );
            }
        }

        const nodes =
            [
                ...nodeMap.values()
            ];

        const nodeIDs =
            new Set(
                nodes.map(
                    node =>
                        node.id
                )
            );

        const edges =
            normalizedEdges.filter(
                edge =>
                    nodeIDs.has(
                        edge.source
                    ) &&
                    nodeIDs.has(
                        edge.target
                    )
            );

        return {
            nodes,
            edges,
            truncated:
                rawNodes.length >
                    maxNodes ||
                rawEdges.length >
                    maxEdges,
            limits: {
                maxNodes,
                maxEdges
            }
        };
    }

    function circularLayout(nodes, width, height, padding) {
        const centerX =
            width / 2;

        const centerY =
            height / 2;

        const radius =
            Math.max(
                0,
                Math.min(
                    width,
                    height
                ) / 2 - padding
            );

        if (nodes.length === 1) {
            return new Map([
                [
                    nodes[0].id,
                    {
                        x: centerX,
                        y: centerY
                    }
                ]
            ]);
        }

        const positions =
            new Map();

        nodes.forEach(
            (node, index) => {
                if (
                    Number.isFinite(node.x) &&
                    Number.isFinite(node.y)
                ) {
                    positions.set(
                        node.id,
                        {
                            x: node.x,
                            y: node.y
                        }
                    );

                    return;
                }

                const angle =
                    (
                        Math.PI * 2 *
                        index
                    ) / Math.max(
                        1,
                        nodes.length
                    ) - Math.PI / 2;

                positions.set(
                    node.id,
                    {
                        x:
                            centerX +
                            Math.cos(angle) *
                            radius,
                        y:
                            centerY +
                            Math.sin(angle) *
                            radius
                    }
                );
            }
        );

        return positions;
    }

    function gridLayout(nodes, width, height, padding) {
        const columns =
            Math.max(
                1,
                Math.ceil(
                    Math.sqrt(
                        nodes.length
                    )
                )
            );

        const rows =
            Math.max(
                1,
                Math.ceil(
                    nodes.length /
                    columns
                )
            );

        const usableWidth =
            Math.max(
                1,
                width - padding * 2
            );

        const usableHeight =
            Math.max(
                1,
                height - padding * 2
            );

        const cellWidth =
            usableWidth /
            columns;

        const cellHeight =
            usableHeight /
            rows;

        const positions =
            new Map();

        nodes.forEach(
            (node, index) => {
                const column =
                    index % columns;

                const row =
                    Math.floor(
                        index / columns
                    );

                positions.set(
                    node.id,
                    {
                        x:
                            padding +
                            cellWidth *
                            column +
                            cellWidth / 2,
                        y:
                            padding +
                            cellHeight *
                            row +
                            cellHeight / 2
                    }
                );
            }
        );

        return positions;
    }

    function layeredLayout(nodes, edges, width, height, padding) {
        const incoming =
            new Map(
                nodes.map(node => [
                    node.id,
                    0
                ])
            );

        const outgoing =
            new Map(
                nodes.map(node => [
                    node.id,
                    []
                ])
            );

        for (const edge of edges) {
            if (incoming.has(edge.target)) {
                incoming.set(
                    edge.target,
                    incoming.get(
                        edge.target
                    ) + 1
                );
            }

            if (outgoing.has(edge.source)) {
                outgoing.get(
                    edge.source
                ).push(
                    edge.target
                );
            }
        }

        const queue =
            nodes
                .filter(node =>
                    incoming.get(node.id) ===
                    0
                )
                .map(node => ({
                    id: node.id,
                    depth: 0
                }));

        const depthMap =
            new Map();

        while (queue.length) {
            const current =
                queue.shift();

            if (
                depthMap.has(current.id) &&
                depthMap.get(current.id) >=
                current.depth
            ) {
                continue;
            }

            depthMap.set(
                current.id,
                current.depth
            );

            for (
                const target of
                outgoing.get(
                    current.id
                ) || []
            ) {
                queue.push({
                    id: target,
                    depth:
                        current.depth + 1
                });
            }
        }

        for (const node of nodes) {
            if (!depthMap.has(node.id)) {
                depthMap.set(
                    node.id,
                    0
                );
            }
        }

        const layers =
            new Map();

        for (const node of nodes) {
            const depth =
                depthMap.get(
                    node.id
                );

            const collection =
                layers.get(depth) || [];

            collection.push(node);
            layers.set(
                depth,
                collection
            );
        }

        const orderedDepths =
            [...layers.keys()].sort(
                (a, b) => a - b
            );

        const positions =
            new Map();

        const layerSpacing =
            orderedDepths.length > 1
                ? (
                    height -
                    padding * 2
                ) /
                (
                    orderedDepths.length -
                    1
                )
                : 0;

        orderedDepths.forEach(
            (depth, layerIndex) => {
                const layer =
                    layers.get(depth);

                const horizontalSpacing =
                    layer.length > 1
                        ? (
                            width -
                            padding * 2
                        ) /
                        (
                            layer.length -
                            1
                        )
                        : 0;

                layer.forEach(
                    (node, nodeIndex) => {
                        positions.set(
                            node.id,
                            {
                                x:
                                    layer.length ===
                                    1
                                        ? width / 2
                                        : padding +
                                          nodeIndex *
                                          horizontalSpacing,
                                y:
                                    padding +
                                    layerIndex *
                                    layerSpacing
                            }
                        );
                    }
                );
            }
        );

        return positions;
    }

    function calculateLayout(graph, options) {
        const width =
            options.width;

        const height =
            options.height;

        const padding =
            options.padding;

        const layout =
            safeString(
                options.layout ||
                "circular"
            ).toLowerCase();

        if (layout === "grid") {
            return gridLayout(
                graph.nodes,
                width,
                height,
                padding
            );
        }

        if (
            layout === "layered" ||
            layout === "hierarchical" ||
            layout === "tree"
        ) {
            return layeredLayout(
                graph.nodes,
                graph.edges,
                width,
                height,
                padding
            );
        }

        return circularLayout(
            graph.nodes,
            width,
            height,
            padding
        );
    }

    function createMarker(svg, id) {
        const defs =
            createSVGElement("defs");

        const marker =
            createSVGElement(
                "marker",
                {
                    id,
                    markerWidth: 10,
                    markerHeight: 10,
                    refX: 9,
                    refY: 3,
                    orient: "auto",
                    markerUnits:
                        "strokeWidth"
                }
            );

        const path =
            createSVGElement(
                "path",
                {
                    d: "M0,0 L0,6 L9,3 z",
                    fill:
                        "currentColor"
                }
            );

        marker.appendChild(path);
        defs.appendChild(marker);
        svg.appendChild(defs);
    }

    function renderGraphSVG(graph, options = {}) {
        const width =
            clampNumber(
                options.width,
                DEFAULT_WIDTH,
                MIN_DIMENSION,
                MAX_DIMENSION
            );

        const height =
            clampNumber(
                options.height,
                DEFAULT_HEIGHT,
                MIN_DIMENSION,
                MAX_DIMENSION
            );

        const nodeRadius =
            clampNumber(
                options.nodeRadius,
                DEFAULT_NODE_RADIUS,
                6,
                80
            );

        const padding =
            clampNumber(
                options.padding,
                nodeRadius * 3,
                nodeRadius * 2,
                Math.min(
                    width,
                    height
                ) / 2
            );

        const svg =
            createSVGElement(
                "svg",
                {
                    viewBox:
                        `0 0 ${width} ${height}`,
                    width: "100%",
                    height:
                        options.height ||
                        DEFAULT_HEIGHT,
                    role: "img",
                    "aria-label":
                        options.ariaLabel ||
                        options.title ||
                        "Terminal graph"
                }
            );

        svg.classList.add(
            "terminal-graph-svg"
        );

        const markerId =
            `terminal-graph-arrow-${Math.random().toString(36).slice(2)}`;

        createMarker(
            svg,
            markerId
        );

        const positions =
            calculateLayout(
                graph,
                {
                    width,
                    height,
                    padding,
                    layout:
                        options.layout ||
                        "circular"
                }
            );

        const edgesGroup =
            createSVGElement(
                "g",
                {
                    class:
                        "terminal-graph-edges"
                }
            );

        for (const edge of graph.edges) {
            const source =
                positions.get(
                    edge.source
                );

            const target =
                positions.get(
                    edge.target
                );

            if (!source || !target) {
                continue;
            }

            const dx =
                target.x -
                source.x;

            const dy =
                target.y -
                source.y;

            const distance =
                Math.hypot(
                    dx,
                    dy
                ) || 1;

            const offsetX =
                (
                    dx /
                    distance
                ) *
                nodeRadius;

            const offsetY =
                (
                    dy /
                    distance
                ) *
                nodeRadius;

            const line =
                createSVGElement(
                    "line",
                    {
                        x1:
                            source.x +
                            offsetX,
                        y1:
                            source.y +
                            offsetY,
                        x2:
                            target.x -
                            offsetX,
                        y2:
                            target.y -
                            offsetY,
                        class:
                            "terminal-graph-edge",
                        "data-edge-id":
                            edge.id,
                        "data-source":
                            edge.source,
                        "data-target":
                            edge.target
                    }
                );

            line.setAttribute(
                "tabindex",
                "0"
            );

            line.setAttribute(
                "role",
                "button"
            );

            line.setAttribute(
                "aria-label",
                edge.label
                    ? `${edge.source} to ${edge.target}: ${edge.label}`
                    : `${edge.source} to ${edge.target}`
            );

            line.addEventListener(
                "click",
                () => {
                    dispatch(
                        svg,
                        "terminal-graph-edge-select",
                        {
                            edge:
                                clone(
                                    edge
                                )
                        }
                    );
                }
            );

            line.addEventListener(
                "keydown",
                event => {
                    if (
                        event.key ===
                            "Enter" ||
                        event.key ===
                            " "
                    ) {
                        event.preventDefault();

                        line.dispatchEvent(
                            new MouseEvent(
                                "click",
                                {
                                    bubbles:
                                        true
                                }
                            )
                        );
                    }
                }
            );

            if (edge.directed) {
                line.setAttribute(
                    "marker-end",
                    `url(#${markerId})`
                );
            }

            const title =
                createSVGElement(
                    "title"
                );

            title.textContent =
                edge.label
                    ? `${edge.source} to ${edge.target}: ${edge.label}`
                    : `${edge.source} to ${edge.target}`;

            line.appendChild(title);
            edgesGroup.appendChild(line);

            if (edge.label) {
                const label =
                    createSVGElement(
                        "text",
                        {
                            x:
                                (
                                    source.x +
                                    target.x
                                ) / 2,
                            y:
                                (
                                    source.y +
                                    target.y
                                ) / 2,
                            class:
                                "terminal-graph-edge-label",
                            "text-anchor":
                                "middle"
                        }
                    );

                label.textContent =
                    edge.label;

                edgesGroup.appendChild(
                    label
                );
            }
        }

        svg.appendChild(edgesGroup);

        const nodesGroup =
            createSVGElement(
                "g",
                {
                    class:
                        "terminal-graph-nodes"
                }
            );

        for (const node of graph.nodes) {
            const position =
                positions.get(
                    node.id
                );

            if (!position) {
                continue;
            }

            const group =
                createSVGElement(
                    "g",
                    {
                        class:
                            "terminal-graph-node",
                        transform:
                            `translate(${position.x} ${position.y})`,
                        tabindex: "0",
                        role: "group",
                        "aria-label":
                            node.label
                    }
                );

            group.dataset.nodeId =
                node.id;

            group.addEventListener(
                "click",
                () => {
                    dispatch(
                        svg,
                        "terminal-graph-node-select",
                        {
                            node:
                                clone(
                                    node
                                )
                        }
                    );
                }
            );

            group.addEventListener(
                "keydown",
                event => {
                    if (
                        event.key ===
                            "Enter" ||
                        event.key ===
                            " "
                    ) {
                        event.preventDefault();

                        group.dispatchEvent(
                            new MouseEvent(
                                "click",
                                {
                                    bubbles:
                                        true
                                }
                            )
                        );

                        return;
                    }

                    if (
                        ![
                            "ArrowRight",
                            "ArrowDown",
                            "ArrowLeft",
                            "ArrowUp"
                        ].includes(
                            event.key
                        )
                    ) {
                        return;
                    }

                    event.preventDefault();

                    const groups =
                        Array.from(
                            svg.querySelectorAll(
                                ".terminal-graph-node"
                            )
                        );

                    const current =
                        groups.indexOf(
                            group
                        );

                    const delta =
                        event.key ===
                            "ArrowRight" ||
                        event.key ===
                            "ArrowDown"
                            ? 1
                            : -1;

                    const next =
                        (
                            current +
                            delta +
                            groups.length
                        ) %
                        groups.length;

                    groups[
                        next
                    ]?.focus();
                }
            );

            const circle =
                createSVGElement(
                    "circle",
                    {
                        r: nodeRadius,
                        class:
                            "terminal-graph-node-shape"
                    }
                );

            if (node.group !== null) {
                circle.dataset.group =
                    safeString(node.group);
            }

            const label =
                createSVGElement(
                    "text",
                    {
                        y:
                            nodeRadius + 18,
                        class:
                            "terminal-graph-node-label",
                        "text-anchor":
                            "middle"
                    }
                );

            label.textContent =
                node.label;

            const title =
                createSVGElement(
                    "title"
                );

            title.textContent =
                node.value === null
                    ? node.label
                    : `${node.label}: ${safeString(node.value)}`;

            circle.appendChild(title);
            group.appendChild(circle);
            group.appendChild(label);
            nodesGroup.appendChild(group);
        }

        svg.appendChild(nodesGroup);

        return svg;
    }

    function createAdjacencyTable(graph) {
        const table =
            document.createElement(
                "table"
            );

        table.className =
            "terminal-graph-table";

        const caption =
            document.createElement(
                "caption"
            );

        caption.textContent =
            "Graph adjacency list";

        table.appendChild(caption);

        const thead =
            document.createElement(
                "thead"
            );

        const headRow =
            document.createElement(
                "tr"
            );

        for (
            const heading of
            [
                "Source",
                "Target",
                "Label",
                "Directed"
            ]
        ) {
            const th =
                document.createElement(
                    "th"
                );

            th.scope = "col";
            th.textContent = heading;
            headRow.appendChild(th);
        }

        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody =
            document.createElement(
                "tbody"
            );

        for (const edge of graph.edges) {
            const row =
                document.createElement(
                    "tr"
                );

            for (
                const value of
                [
                    edge.source,
                    edge.target,
                    edge.label,
                    edge.directed
                        ? "yes"
                        : "no"
                ]
            ) {
                const cell =
                    document.createElement(
                        "td"
                    );

                cell.textContent =
                    safeString(value);

                row.appendChild(cell);
            }

            tbody.appendChild(row);
        }

        table.appendChild(tbody);
        return table;
    }

    function buildGraphElement(
        data,
        options =
            {}
    ) {
        const graph =
            normalizeGraph(
                data,
                options
            );

        const container =
            document.createElement(
                "section"
            );

        container.className =
            "terminal-renderer terminal-renderer-graph";
        container.dataset.renderer =
            "graph";
        container.dataset.nodeCount =
            String(
                graph.nodes.length
            );
        container.dataset.edgeCount =
            String(
                graph.edges.length
            );

        container.dataset.truncated =
            graph.truncated
                ? "true"
                : "false";

        if (options.title) {
            const heading =
                document.createElement(
                    "h3"
                );

            heading.textContent =
                options.title;

            container.appendChild(
                heading
            );
        }

        if (!graph.nodes.length) {
            const empty =
                document.createElement(
                    "p"
                );

            empty.className =
                "terminal-renderer-empty";
            empty.textContent =
                options.emptyMessage ||
                "No graph nodes available.";

            container.appendChild(empty);
            return container;
        }

        const summary =
            document.createElement(
                "p"
            );

        summary.className =
            "terminal-graph-summary";
        summary.textContent =
            `${graph.nodes.length} node${graph.nodes.length === 1 ? "" : "s"}, ${graph.edges.length} edge${graph.edges.length === 1 ? "" : "s"}`;

        container.appendChild(summary);

        container.appendChild(
            renderGraphSVG(
                graph,
                options
            )
        );

        if (
            options.table !== false
        ) {
            const details =
                document.createElement(
                    "details"
                );

            details.className =
                "terminal-graph-data";

            const summaryElement =
                document.createElement(
                    "summary"
                );

            summaryElement.textContent =
                "Graph data";

            details.appendChild(
                summaryElement
            );

            details.appendChild(
                createAdjacencyTable(
                    graph
                )
            );

            container.appendChild(
                details
            );
        }

        return container;
    }

    class GraphRenderer extends EventTarget {
        constructor(
            context =
                {}
        ) {
            super();

            this.context =
                context;

            this.instances =
                new Set();

            this.destroyed =
                false;

            this.metrics = {
                renders:
                    0,
                refreshes:
                    0,
                nodeSelections:
                    0,
                edgeSelections:
                    0,
                destroyedInstances:
                    0
            };
        }

        assertActive() {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "Graph renderer has been destroyed."
                );
            }
        }

        render(
            data,
            options =
                {}
        ) {
            this.assertActive();

            const container =
                buildGraphElement(
                    data,
                    options
                );

            const state = {
                data:
                    clone(
                        data
                    ),
                options: {
                    ...options
                },
                destroyed:
                    false
            };

            const instance = {
                element:
                    container,

                state,

                refresh:
                    (
                        nextData =
                            state.data,
                        nextOptions =
                            {}
                    ) => {
                        if (
                            state.destroyed
                        ) {
                            return container;
                        }

                        state.data =
                            clone(
                                nextData
                            );

                        state.options = {
                            ...state.options,
                            ...nextOptions
                        };

                        const replacement =
                            buildGraphElement(
                                state.data,
                                state.options
                            );

                        container.replaceChildren(
                            ...replacement.childNodes
                        );

                        for (
                            const [
                                key,
                                value
                            ] of Object.entries(
                                replacement.dataset
                            )
                        ) {
                            container.dataset[
                                key
                            ] =
                                value;
                        }

                        this.metrics.refreshes +=
                            1;

                        dispatch(
                            container,
                            "terminal-graph-refresh",
                            instance.status()
                        );

                        return container;
                    },

                setData:
                    (
                        nextData,
                        nextOptions =
                            {}
                    ) =>
                        instance.refresh(
                            nextData,
                            nextOptions
                        ),

                setLayout:
                    layout =>
                        instance.refresh(
                            state.data,
                            {
                                layout
                            }
                        ),

                status:
                    () => ({
                        version:
                            VERSION,
                        nodes:
                            Number(
                                container.dataset.nodeCount ||
                                0
                            ),
                        edges:
                            Number(
                                container.dataset.edgeCount ||
                                0
                            ),
                        layout:
                            state.options.layout ||
                            "circular",
                        truncated:
                            container.dataset.truncated ===
                            "true",
                        destroyed:
                            state.destroyed
                    }),

                destroy:
                    () => {
                        if (
                            state.destroyed
                        ) {
                            return false;
                        }

                        state.destroyed =
                            true;

                        this.instances.delete(
                            instance
                        );

                        if (
                            container[
                                INSTANCE_SYMBOL
                            ] ===
                                instance
                        ) {
                            delete container[
                                INSTANCE_SYMBOL
                            ];
                        }

                        container.remove();

                        this.metrics.destroyedInstances +=
                            1;

                        return true;
                    }
            };

            container[
                INSTANCE_SYMBOL
            ] =
                instance;

            container.graphInstance =
                instance;

            container.update =
                instance.refresh;

            container.setData =
                instance.setData;

            container.destroy =
                instance.destroy;

            container.addEventListener(
                "terminal-graph-node-select",
                () => {
                    this.metrics.nodeSelections +=
                        1;
                }
            );

            container.addEventListener(
                "terminal-graph-edge-select",
                () => {
                    this.metrics.edgeSelections +=
                        1;
                }
            );

            this.instances.add(
                instance
            );

            this.metrics.renders +=
                1;

            return container;
        }

        activeInstance() {
            const element =
                this.context.root?.
                    querySelector?.(
                        ".terminal-renderer-graph"
                    ) ||
                document.querySelector(
                    ".terminal-renderer-graph"
                );

            return (
                element?.[
                    INSTANCE_SYMBOL
                ] ||
                element?.
                    graphInstance ||
                Array.from(
                    this.instances
                ).at(
                    -1
                ) ||
                null
            );
        }

        mount(
            target,
            data,
            options =
                {}
        ) {
            const element =
                this.render(
                    data,
                    options
                );

            if (
                isElement(
                    target
                )
            ) {
                target.replaceChildren(
                    element
                );
            }

            return element;
        }

        status() {
            return {
                version:
                    VERSION,
                instances:
                    this.instances.size,
                metrics: {
                    ...this.metrics
                },
                active:
                    this.activeInstance?.
                        ()?.
                        status?.() ||
                    null,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (
                this.destroyed
            ) {
                return false;
            }

            for (
                const instance of
                Array.from(
                    this.instances
                )
            ) {
                instance.destroy();
            }

            this.instances.clear();

            if (
                this.context.root?.[
                    RENDERER_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    RENDERER_SYMBOL
                ];
            }

            this.destroyed =
                true;

            dispatch(
                this,
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            return true;
        }
    }

    function render(
        data,
        options =
            {}
    ) {
        const renderer =
            new GraphRenderer(
                {}
            );

        return renderer.render(
            data,
            options
        );
    }

    function initialize(
        context
    ) {
        const root =
            context.root;

        const existing =
            context.graphRenderer instanceof
                GraphRenderer
                ? context.graphRenderer
                : root?.[
                    RENDERER_SYMBOL
                ];

        if (
            existing instanceof
                GraphRenderer &&
            !existing.destroyed
        ) {
            context.graphRenderer =
                existing;

            context.registerRenderer?.(
                "graph",
                existing
            );

            context.registerRenderer?.(
                "graphs",
                existing
            );

            return existing;
        }

        const renderer =
            new GraphRenderer(
                context
            );

        root[
            RENDERER_SYMBOL
        ] =
            renderer;

        context.registerRenderer?.(
            "graph",
            renderer
        );

        context.registerRenderer?.(
            "graphs",
            renderer
        );

        context.registerVisualization?.(
            "graph",
            renderer
        );

        context.graphRenderer =
            renderer;

        context.registerService?.(
            "graphs",
            renderer
        );

        dispatch(
            document,
            "speciedex:terminal-graphs-ready",
            {
                context,
                renderer,
                version:
                    VERSION
            }
        );

        return renderer;
    }

    function parseCommandGraph(args) {
        const options = {
            layout:
                "circular",
            title:
                "",
            width:
                DEFAULT_WIDTH,
            height:
                DEFAULT_HEIGHT,
            maxNodes:
                DEFAULT_MAX_NODES,
            maxEdges:
                DEFAULT_MAX_EDGES,
            table:
                true
        };

        const edgeTokens = [];

        for (const argument of args) {
            if (
                argument.startsWith(
                    "--layout="
                )
            ) {
                options.layout =
                    argument
                        .slice(9)
                        .trim() ||
                    "circular";

                continue;
            }

            if (
                argument.startsWith(
                    "--title="
                )
            ) {
                options.title =
                    argument
                        .slice(8)
                        .trim();

                continue;
            }

            if (
                argument.startsWith(
                    "--width="
                )
            ) {
                options.width =
                    argument.slice(
                        8
                    );

                continue;
            }

            if (
                argument.startsWith(
                    "--height="
                )
            ) {
                options.height =
                    argument.slice(
                        9
                    );

                continue;
            }

            if (
                argument.startsWith(
                    "--max-nodes="
                )
            ) {
                options.maxNodes =
                    argument.slice(
                        12
                    );

                continue;
            }

            if (
                argument.startsWith(
                    "--max-edges="
                )
            ) {
                options.maxEdges =
                    argument.slice(
                        12
                    );

                continue;
            }

            if (
                argument ===
                "--no-table"
            ) {
                options.table =
                    false;

                continue;
            }

            edgeTokens.push(argument);
        }

        const edges =
            edgeTokens
                .map(parseEdgeString)
                .filter(Boolean);

        return {
            graph: {
                edges
            },
            options
        };
    }

    const commands = [
        {
            name: "graph",
            aliases: [
                "graphs"
            ],
            category: "visualization",
            description:
                "Render a node-edge graph.",
            usage:
                "graph <source->target> [...] [--layout=circular|grid|layered] [--title=Title]",
            handler: ({
                args = [],
                context,
                write,
                writeNode
            }) => {
                const renderer =
                    context.graphRenderer ||
                    initialize(context);

                const {
                    graph,
                    options
                } =
                    parseCommandGraph(
                        args
                    );

                let source =
                    graph;

                const literalTokens =
                    args.filter(
                        argument =>
                            !argument.startsWith(
                                "--"
                            )
                    );

                if (
                    !graph.edges.length &&
                    literalTokens.length ===
                        1
                ) {
                    const collectionName =
                        literalTokens[
                            0
                        ];

                    const library =
                        context.library ||
                        context.services?.get?.(
                            "library"
                        );

                    const collection =
                        library?.get?.(
                            collectionName
                        );

                    if (
                        collection !==
                            undefined &&
                        collection !==
                            null
                    ) {
                        source =
                            collection;
                    }
                }

                const normalized =
                    normalizeGraph(
                        source,
                        options
                    );

                if (
                    !normalized.nodes.length
                ) {
                    throw new Error(
                        "Graph data is empty. Provide edge expressions, JSON, or a Library collection name."
                    );
                }

                const node =
                    renderer.render(
                        source,
                        options
                    );

                if (
                    typeof writeNode ===
                    "function"
                ) {
                    return writeNode(node);
                }

                if (
                    typeof context.writeNode ===
                    "function"
                ) {
                    return context.writeNode(
                        node
                    );
                }

                if (
                    typeof write ===
                    "function"
                ) {
                    return write(
                        `${node.dataset.nodeCount} graph nodes and ${node.dataset.edgeCount} graph edges rendered.`,
                        "success"
                    );
                }

                return node;
            }
        },
        {
            name:
                "graph-layout",

            category:
                "visualization",

            description:
                "Change the active graph layout.",

            usage:
                "graph-layout <circular|grid|layered>",

            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const renderer =
                    context.graphRenderer ||
                    initialize(
                        context
                    );

                const instance =
                    renderer.activeInstance();

                if (!instance) {
                    throw new Error(
                        "No active graph renderer is available."
                    );
                }

                const layout =
                    String(
                        args[0] ||
                        ""
                    ).toLowerCase();

                if (
                    ![
                        "circular",
                        "grid",
                        "layered",
                        "hierarchical",
                        "tree"
                    ].includes(
                        layout
                    )
                ) {
                    throw new Error(
                        "Use: graph-layout circular|grid|layered"
                    );
                }

                instance.setLayout(
                    layout
                );

                const status =
                    instance.status();

                return typeof writeJSON ===
                    "function"
                        ? writeJSON(
                            status
                        )
                        : status;
            }
        },

        {
            name: "graph-status",
            category: "visualization",
            description:
                "Show graph-renderer status.",
            usage:
                "graph-status",
            handler: ({
                context,
                writeJSON
            }) => {
                const renderer =
                    context.graphRenderer ||
                    initialize(context);

                const status = {
                    name:
                        MODULE_NAME,
                    ...renderer.status(),
                    layouts: [
                        "circular",
                        "grid",
                        "layered"
                    ],
                    limits: {
                        nodes:
                            DEFAULT_MAX_NODES,
                        edges:
                            DEFAULT_MAX_EDGES,
                        width:
                            MAX_DIMENSION,
                        height:
                            MAX_DIMENSION
                    }
                };

                return typeof writeJSON ===
                    "function"
                        ? writeJSON(status)
                        : status;
            }
        }
    ];

    const api = Object.freeze({
        name:
            MODULE_NAME,
        version:
            VERSION,
        RENDERER_SYMBOL,
        INSTANCE_SYMBOL,
        GraphRenderer,
        clone,
        normalizeNode,
        normalizeEdge,
        normalizeGraph,
        parseEdgeString,
        circularLayout,
        gridLayout,
        layeredLayout,
        renderGraphSVG,
        createAdjacencyTable,
        buildGraphElement,
        render,
        initialize,
        mount:
            initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalGraphs =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    dispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
