/*
========================================================================
Speciedex.org
Terminal Tree Renderer
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Tree";
    const VERSION = "2.2.0";

    const RENDERER_SYMBOL = Symbol.for(
        "speciedex.terminal.tree.renderer"
    );
    const INSTANCE_SYMBOL = Symbol.for(
        "speciedex.terminal.tree.instance"
    );

    const DEFAULT_MAX_DEPTH = 64;
    const DEFAULT_MAX_NODES = 10000;
    const DEFAULT_EMPTY_TEXT = "No tree data.";
    const DEFAULT_FILTER_DEBOUNCE = 120;
    const DEFAULT_METADATA_LIMIT = 128;
    const DEFAULT_METADATA_DEPTH = 8;

    const RESERVED_KEYS = new Set([
        "__proto__",
        "prototype",
        "constructor"
    ]);

    const DEFAULT_CHILD_KEYS = Object.freeze([
        "children",
        "nodes",
        "items",
        "branches",
        "descendants",
        "taxa"
    ]);

    function now() {
        return Date.now();
    }

    function iso(timestamp = now()) {
        try {
            return new Date(timestamp).toISOString();
        } catch (_error) {
            return new Date().toISOString();
        }
    }

    function isObject(value) {
        return value !== null &&
            typeof value === "object" &&
            !Array.isArray(value);
    }

    function isNode(value) {
        return Boolean(
            value &&
            typeof value.nodeType === "number"
        );
    }

    function isElement(value) {
        return Boolean(
            value &&
            value.nodeType === 1 &&
            typeof value.querySelector === "function"
        );
    }

    function parseNumber(
        value,
        fallback,
        minimum = -Infinity,
        maximum = Infinity,
        integer = false
    ) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        const bounded = Math.min(
            maximum,
            Math.max(
                minimum,
                number
            )
        );

        return integer
            ? Math.trunc(bounded)
            : bounded;
    }

    function normalizeText(value, fallback = "") {
        if (
            value === undefined ||
            value === null
        ) {
            return fallback;
        }

        const text = String(value).trim();
        return text || fallback;
    }

    function clone(
        value,
        seen = new WeakMap()
    ) {
        if (
            value === undefined ||
            value === null ||
            typeof value !== "object"
        ) {
            return value;
        }

        if (
            typeof structuredClone === "function"
        ) {
            try {
                return structuredClone(value);
            } catch (_error) {
                /* Continue with deterministic fallback. */
            }
        }

        if (seen.has(value)) {
            return seen.get(value);
        }

        if (value instanceof Date) {
            return new Date(value.getTime());
        }

        if (value instanceof RegExp) {
            return new RegExp(value.source, value.flags);
        }

        if (value instanceof Map) {
            const output = new Map();
            seen.set(value, output);

            for (const [key, item] of value.entries()) {
                output.set(
                    clone(key, seen),
                    clone(item, seen)
                );
            }

            return output;
        }

        if (value instanceof Set) {
            const output = new Set();
            seen.set(value, output);

            for (const item of value.values()) {
                output.add(clone(item, seen));
            }

            return output;
        }

        if (Array.isArray(value)) {
            const output = [];
            seen.set(value, output);

            for (const item of value) {
                output.push(clone(item, seen));
            }

            return output;
        }

        if (isNode(value)) {
            return value.cloneNode?.(true) || null;
        }

        const output = {};
        seen.set(value, output);

        for (const [key, item] of Object.entries(value)) {
            if (RESERVED_KEYS.has(key)) {
                continue;
            }

            output[key] = clone(item, seen);
        }

        return output;
    }

    function safeDispatch(target, name, detail) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function"
        ) {
            return false;
        }

        try {
            target.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        detail
                    }
                )
            );

            return true;
        } catch (_error) {
            return false;
        }
    }

    function createElement(
        tagName,
        className,
        text
    ) {
        const element = document.createElement(tagName);

        if (className) {
            element.className = className;
        }

        if (text !== undefined) {
            element.textContent = text;
        }

        return element;
    }

    function safeStringify(
        value,
        {
            space = 2,
            maxDepth = DEFAULT_METADATA_DEPTH,
            maxEntries = DEFAULT_METADATA_LIMIT
        } = {}
    ) {
        const seen = new WeakSet();

        function prepare(item, depth) {
            if (
                item === null ||
                item === undefined ||
                typeof item !== "object"
            ) {
                if (typeof item === "bigint") {
                    return String(item);
                }

                if (typeof item === "function") {
                    return `[Function ${item.name || "anonymous"}]`;
                }

                if (typeof item === "symbol") {
                    return String(item);
                }

                return item;
            }

            if (isNode(item)) {
                return `[DOM ${item.nodeName || "Node"}]`;
            }

            if (seen.has(item)) {
                return "[Circular]";
            }

            if (depth >= maxDepth) {
                return "[Max depth]";
            }

            seen.add(item);

            if (item instanceof Date) {
                return iso(item.getTime());
            }

            if (item instanceof RegExp) {
                return item.toString();
            }

            if (item instanceof Map) {
                return Array.from(item.entries())
                    .slice(0, maxEntries)
                    .map(([key, value]) => [
                        prepare(key, depth + 1),
                        prepare(value, depth + 1)
                    ]);
            }

            if (item instanceof Set) {
                return Array.from(item.values())
                    .slice(0, maxEntries)
                    .map(value => prepare(value, depth + 1));
            }

            if (Array.isArray(item)) {
                const output = item
                    .slice(0, maxEntries)
                    .map(value => prepare(value, depth + 1));

                if (item.length > maxEntries) {
                    output.push(
                        `[${item.length - maxEntries} more item(s)]`
                    );
                }

                return output;
            }

            const output = {};
            const entries = Object.entries(item)
                .filter(([key]) => !RESERVED_KEYS.has(key))
                .slice(0, maxEntries);

            for (const [key, value] of entries) {
                output[key] = prepare(value, depth + 1);
            }

            const total = Object.keys(item).length;

            if (total > entries.length) {
                output.__truncated__ =
                    `${total - entries.length} more entr${total - entries.length === 1 ? "y" : "ies"}`;
            }

            return output;
        }

        try {
            return JSON.stringify(
                prepare(value, 0),
                null,
                space
            );
        } catch (error) {
            return JSON.stringify({
                error: "Unable to serialize value.",
                message: String(error?.message || error)
            }, null, space);
        }
    }

    function getChildCollection(
        value,
        options = {}
    ) {
        if (!isObject(value)) {
            return null;
        }

        const childKeys =
            Array.isArray(options.childKeys) &&
            options.childKeys.length
                ? options.childKeys
                : DEFAULT_CHILD_KEYS;

        for (const rawKey of childKeys) {
            const key = String(rawKey);

            if (RESERVED_KEYS.has(key)) {
                continue;
            }

            if (Array.isArray(value[key])) {
                return {
                    key,
                    children: value[key]
                };
            }

            if (isObject(value[key])) {
                return {
                    key,
                    children: Object.entries(value[key])
                        .filter(([name]) => !RESERVED_KEYS.has(name))
                        .map(([name, child]) => {
                            if (isObject(child)) {
                                return {
                                    __treeKey: name,
                                    ...child
                                };
                            }

                            return {
                                __treeKey: name,
                                value: child
                            };
                        })
                };
            }
        }

        return null;
    }

    function inferLabel(value, fallback) {
        if (!isObject(value)) {
            return normalizeText(value, fallback);
        }

        return normalizeText(
            value.label ??
            value.name ??
            value.title ??
            value.scientificName ??
            value.commonName ??
            value.id ??
            value.key ??
            value.__treeKey,
            fallback
        );
    }

    function inferId(value, path, fallback) {
        if (isObject(value)) {
            const candidate =
                value.id ??
                value.key ??
                value.slug ??
                value.uuid ??
                value.taxonId ??
                value.identifier;

            if (
                candidate !== undefined &&
                candidate !== null &&
                candidate !== ""
            ) {
                return String(candidate);
            }
        }

        return path || fallback;
    }

    function extractMetadata(value, childKey) {
        if (!isObject(value)) {
            return {
                value
            };
        }

        const reserved = new Set([
            childKey,
            ...DEFAULT_CHILD_KEYS,
            "id",
            "key",
            "slug",
            "uuid",
            "identifier",
            "taxonId",
            "label",
            "name",
            "title",
            "scientificName",
            "commonName",
            "description",
            "summary",
            "details",
            "type",
            "kind",
            "category",
            "status",
            "icon",
            "__treeKey",
            "__proto__",
            "prototype",
            "constructor"
        ]);

        const metadata = {};

        for (const [key, item] of Object.entries(value)) {
            if (!reserved.has(key)) {
                metadata[key] = item;
            }
        }

        return metadata;
    }

    function normalizeNode(
        value,
        options,
        state,
        depth,
        path,
        index,
        parentId
    ) {
        if (
            value &&
            typeof value === "object"
        ) {
            if (state.seen.has(value)) {
                state.truncated = true;
                state.cycles += 1;
                return null;
            }

            state.seen.add(value);
        }

        if (state.nodeCount >= state.maxNodes) {
            state.truncated = true;
            return null;
        }

        if (depth > state.maxDepth) {
            state.truncated = true;
            return null;
        }

        const fallbackLabel =
            `Node ${state.nodeCount + 1}`;
        const label =
            inferLabel(value, fallbackLabel);
        const requestedId =
            inferId(value, path, fallbackLabel);

        let id = requestedId;
        let duplicateIndex = 1;

        while (state.byId.has(id)) {
            duplicateIndex += 1;
            id = `${requestedId}:${duplicateIndex}`;
        }

        const childCollection =
            getChildCollection(value, options);
        const childValues =
            childCollection?.children || [];

        const node = {
            id,
            label,
            path,
            parentId,
            depth,
            index,
            description: isObject(value)
                ? normalizeText(
                    value.description ??
                    value.summary ??
                    value.details
                )
                : "",
            type: isObject(value)
                ? normalizeText(
                    value.type ??
                    value.kind ??
                    value.category,
                    "node"
                )
                : typeof value,
            status:
                isObject(value) &&
                value.status !== undefined
                    ? normalizeText(value.status)
                    : null,
            icon:
                isObject(value) &&
                value.icon !== undefined
                    ? normalizeText(value.icon)
                    : null,
            metadata:
                extractMetadata(
                    value,
                    childCollection?.key
                ),
            raw:
                clone(value),
            children:
                [],
            hasChildren:
                childValues.length > 0,
            childCount:
                childValues.length
        };

        state.nodeCount += 1;
        state.byId.set(node.id, node);
        state.byPath.set(node.path, node);

        for (
            let childIndex = 0;
            childIndex < childValues.length;
            childIndex += 1
        ) {
            const child = childValues[childIndex];
            const childLabel =
                inferLabel(child, String(childIndex));
            const safeSegment =
                String(childLabel || childIndex)
                    .replace(/[./\\]/g, "_");
            const childPath = path
                ? `${path}.${safeSegment}`
                : safeSegment;

            const normalized = normalizeNode(
                child,
                options,
                state,
                depth + 1,
                childPath,
                childIndex,
                node.id
            );

            if (normalized) {
                node.children.push(normalized);
            }
        }

        node.childCount = node.children.length;
        node.hasChildren = node.childCount > 0;

        return node;
    }

    function normalizeTree(
        data,
        options = {}
    ) {
        const maxDepth = parseNumber(
            options.maxDepth,
            DEFAULT_MAX_DEPTH,
            0,
            1024,
            true
        );
        const maxNodes = parseNumber(
            options.maxNodes,
            DEFAULT_MAX_NODES,
            1,
            1000000,
            true
        );

        const state = {
            maxDepth,
            maxNodes,
            nodeCount: 0,
            truncated: false,
            cycles: 0,
            byId: new Map(),
            byPath: new Map(),
            seen: new WeakSet()
        };

        let roots;

        if (Array.isArray(data)) {
            roots = data;
        } else if (isObject(data)) {
            const childCollection =
                getChildCollection(data, options);

            if (
                options.rootless === true &&
                childCollection &&
                childCollection.children.length
            ) {
                roots = childCollection.children;
            } else if (
                !childCollection &&
                options.objectMode === "entries"
            ) {
                roots = Object.entries(data)
                    .filter(([key]) => !RESERVED_KEYS.has(key))
                    .map(([key, value]) => {
                        if (isObject(value)) {
                            return {
                                __treeKey: key,
                                ...value
                            };
                        }

                        return {
                            __treeKey: key,
                            value
                        };
                    });
            } else {
                roots = [data];
            }
        } else if (
            data === null ||
            data === undefined
        ) {
            roots = [];
        } else {
            roots = [data];
        }

        const normalizedRoots = [];

        for (
            let index = 0;
            index < roots.length;
            index += 1
        ) {
            const value = roots[index];
            const label =
                inferLabel(value, `root-${index + 1}`);
            const path =
                String(label || index)
                    .replace(/[./\\]/g, "_");

            const node = normalizeNode(
                value,
                options,
                state,
                0,
                path,
                index,
                null
            );

            if (node) {
                normalizedRoots.push(node);
            }
        }

        return {
            roots: normalizedRoots,
            count: state.nodeCount,
            truncated: state.truncated,
            cycles: state.cycles,
            byId: state.byId,
            byPath: state.byPath,
            maxDepth,
            maxNodes
        };
    }

    function walkNodes(
        nodes,
        callback
    ) {
        const stack = Array.from(nodes || [])
            .reverse();

        while (stack.length) {
            const node = stack.pop();
            callback(node);

            for (
                let index = node.children.length - 1;
                index >= 0;
                index -= 1
            ) {
                stack.push(node.children[index]);
            }
        }
    }

    function nodeMatches(
        node,
        query
    ) {
        const normalizedQuery =
            String(query || "")
                .trim()
                .toLowerCase();

        if (!normalizedQuery) {
            return true;
        }

        const metadata =
            safeStringify(
                node.metadata,
                {
                    space: 0,
                    maxDepth:
                        DEFAULT_METADATA_DEPTH,
                    maxEntries:
                        DEFAULT_METADATA_LIMIT
                }
            );

        const haystack = [
            node.id,
            node.label,
            node.description,
            node.type,
            node.status,
            metadata
        ]
            .join(" ")
            .toLowerCase();

        return haystack.includes(normalizedQuery);
    }

    class TreeRenderer extends EventTarget {
        constructor(context = {}) {
            super();

            this.context = context;
            this.instances = new Set();
            this.destroyed = false;
            this.lastError = null;
            this.metrics = {
                renders: 0,
                refreshes: 0,
                filters: 0,
                expansions: 0,
                selections: 0,
                destroyedInstances: 0,
                errors: 0
            };
        }

        assertActive() {
            if (this.destroyed) {
                throw new Error(
                    "Tree renderer has been destroyed."
                );
            }
        }

        _recordError(error) {
            this.lastError =
                error instanceof Error
                    ? error
                    : new Error(String(error));

            this.metrics.errors += 1;
            return this.lastError;
        }

        _emit(
            type,
            detail = {}
        ) {
            if (
                this.destroyed &&
                type !== "destroy"
            ) {
                return null;
            }

            const event = {
                type,
                timestamp: iso(),
                ...detail
            };

            safeDispatch(this, type, event);

            try {
                this.context.events?.emit?.(
                    `tree:${type}`,
                    event
                );
            } catch (error) {
                this._recordError(error);
            }

            safeDispatch(
                document,
                `speciedex:terminal-tree-${type}`,
                event
            );

            return event;
        }

        render(
            data,
            options = {}
        ) {
            this.assertActive();

            const renderer = this;
            const state = {
                data,
                options: {
                    ...options
                },
                tree:
                    normalizeTree(data, options),
                expanded:
                    new Set(),
                selectedId:
                    null,
                focusedId:
                    null,
                query:
                    "",
                matched:
                    new Set(),
                hidden:
                    new Set(),
                destroyed:
                    false,
                abortController:
                    new AbortController(),
                filterTimer:
                    null,
                controlsAbortController:
                    new AbortController()
            };

            const container = createElement(
                "section",
                "terminal-renderer terminal-renderer-tree"
            );
            container.dataset.renderer = "tree";
            container.setAttribute("role", "region");

            const header = createElement(
                "header",
                "terminal-tree-header"
            );
            const controls = createElement(
                "div",
                "terminal-tree-controls"
            );
            const status = createElement(
                "div",
                "terminal-tree-status"
            );
            status.setAttribute(
                "aria-live",
                "polite"
            );

            const viewport = createElement(
                "div",
                "terminal-tree-viewport"
            );
            viewport.tabIndex = 0;

            const tree = createElement(
                "ul",
                "terminal-tree-root"
            );
            tree.setAttribute("role", "tree");

            const empty = createElement(
                "div",
                "terminal-tree-empty"
            );
            empty.hidden = true;

            const footer = createElement(
                "footer",
                "terminal-tree-footer"
            );
            const summary = createElement(
                "div",
                "terminal-tree-summary"
            );

            let titleElement = null;
            let descriptionElement = null;
            let searchInput = null;

            viewport.appendChild(tree);
            footer.appendChild(summary);
            container.append(
                header,
                viewport,
                empty,
                footer
            );

            function currentOptions() {
                return state.options;
            }

            function applyInitialExpansion() {
                state.expanded.clear();

                const opts = currentOptions();
                const depth = parseNumber(
                    opts.expandedDepth,
                    opts.collapsed === true
                        ? -1
                        : 1,
                    -1,
                    state.tree.maxDepth,
                    true
                );

                walkNodes(
                    state.tree.roots,
                    node => {
                        if (
                            node.hasChildren &&
                            node.depth <= depth
                        ) {
                            state.expanded.add(node.id);
                        }
                    }
                );
            }

            function emitExpansion(
                type,
                node = null
            ) {
                safeDispatch(
                    container,
                    "terminal-tree-expansion",
                    {
                        type,
                        node:
                            node
                                ? clone(node)
                                : null,
                        expanded:
                            Array.from(state.expanded)
                    }
                );

                renderer._emit(
                    "expansion",
                    {
                        type,
                        nodeId:
                            node?.id || null,
                        expanded:
                            state.expanded.size
                    }
                );
            }

            function visibleNodes() {
                const output = [];

                walkNodes(
                    state.tree.roots,
                    node => {
                        if (!state.hidden.has(node.id)) {
                            output.push(node);
                        }
                    }
                );

                return output;
            }

            function filterTree() {
                state.matched.clear();
                state.hidden.clear();

                const query =
                    state.query
                        .trim()
                        .toLowerCase();

                if (!query) {
                    return;
                }

                const visible = new Set();

                function visit(node) {
                    let descendantMatches = false;

                    for (const child of node.children) {
                        if (visit(child)) {
                            descendantMatches = true;
                        }
                    }

                    const matches =
                        nodeMatches(node, query);

                    if (matches) {
                        state.matched.add(node.id);
                    }

                    if (
                        matches ||
                        descendantMatches
                    ) {
                        visible.add(node.id);

                        if (descendantMatches) {
                            state.expanded.add(node.id);
                        }

                        return true;
                    }

                    return false;
                }

                for (const root of state.tree.roots) {
                    visit(root);
                }

                walkNodes(
                    state.tree.roots,
                    node => {
                        if (!visible.has(node.id)) {
                            state.hidden.add(node.id);
                        }
                    }
                );
            }

            function metadataElement(node) {
                const opts = currentOptions();

                if (opts.showMetadata === false) {
                    return null;
                }

                const limit = parseNumber(
                    opts.metadataLimit,
                    DEFAULT_METADATA_LIMIT,
                    0,
                    10000,
                    true
                );

                const entries =
                    Object.entries(node.metadata || {})
                        .slice(0, limit);

                if (!entries.length) {
                    return null;
                }

                const details = createElement(
                    "details",
                    "terminal-tree-metadata"
                );
                const detailsSummary = createElement(
                    "summary",
                    "terminal-tree-metadata-summary",
                    opts.metadataLabel || "Details"
                );
                const list = createElement(
                    "dl",
                    "terminal-tree-metadata-list"
                );

                for (const [key, value] of entries) {
                    const term = createElement(
                        "dt",
                        "terminal-tree-metadata-key",
                        key
                    );
                    const description = createElement(
                        "dd",
                        "terminal-tree-metadata-value"
                    );

                    if (isNode(value)) {
                        description.appendChild(
                            value.cloneNode?.(true) ||
                            document.createTextNode(
                                `[DOM ${value.nodeName || "Node"}]`
                            )
                        );
                    } else if (
                        isObject(value) ||
                        Array.isArray(value)
                    ) {
                        description.appendChild(
                            createElement(
                                "pre",
                                "terminal-tree-metadata-json",
                                safeStringify(
                                    value,
                                    {
                                        space: 2,
                                        maxDepth:
                                            parseNumber(
                                                opts.metadataDepth,
                                                DEFAULT_METADATA_DEPTH,
                                                1,
                                                64,
                                                true
                                            ),
                                        maxEntries:
                                            limit
                                    }
                                )
                            )
                        );
                    } else {
                        description.textContent =
                            String(value ?? "");
                    }

                    list.append(term, description);
                }

                details.append(
                    detailsSummary,
                    list
                );

                return details;
            }

            function focusRowById(id) {
                if (!id) {
                    return false;
                }

                const row = tree.querySelector(
                    `.terminal-tree-row[data-node-id="${CSS.escape(String(id))}"]`
                );

                if (!row) {
                    return false;
                }

                row.focus();
                return true;
            }

            function selectNode(
                node,
                item = null
            ) {
                state.selectedId = node.id;
                state.focusedId = node.id;

                renderTree({
                    restoreFocus: true
                });

                const opts = currentOptions();

                if (
                    typeof opts.onSelect === "function"
                ) {
                    try {
                        opts.onSelect(
                            clone(node),
                            item
                        );
                    } catch (error) {
                        renderer._recordError(error);
                    }
                }

                renderer.metrics.selections += 1;

                safeDispatch(
                    container,
                    "terminal-tree-select",
                    {
                        node:
                            clone(node)
                    }
                );

                renderer._emit(
                    "select",
                    {
                        nodeId:
                            node.id
                    }
                );
            }

            function createNodeElement(
                node,
                siblingIndex,
                siblingCount
            ) {
                const opts = currentOptions();
                const item = createElement(
                    "li",
                    "terminal-tree-node"
                );

                item.dataset.nodeId = node.id;
                item.dataset.path = node.path;
                item.dataset.depth = String(node.depth);
                item.dataset.type = node.type || "node";
                item.setAttribute("role", "treeitem");
                item.setAttribute(
                    "aria-level",
                    String(node.depth + 1)
                );
                item.setAttribute(
                    "aria-posinset",
                    String(siblingIndex + 1)
                );
                item.setAttribute(
                    "aria-setsize",
                    String(siblingCount)
                );

                if (node.status) {
                    item.dataset.status = node.status;
                }

                if (node.hasChildren) {
                    item.setAttribute(
                        "aria-expanded",
                        state.expanded.has(node.id)
                            ? "true"
                            : "false"
                    );
                }

                item.classList.toggle(
                    "is-selected",
                    state.selectedId === node.id
                );
                item.classList.toggle(
                    "is-match",
                    state.matched.has(node.id)
                );

                const row = createElement(
                    "div",
                    "terminal-tree-row"
                );
                row.dataset.nodeId = node.id;
                row.tabIndex =
                    state.focusedId === node.id
                        ? 0
                        : -1;

                const toggle = createElement(
                    "button",
                    "terminal-tree-toggle"
                );
                toggle.type = "button";
                toggle.disabled = !node.hasChildren;
                toggle.tabIndex = -1;
                toggle.setAttribute(
                    "aria-hidden",
                    node.hasChildren
                        ? "false"
                        : "true"
                );
                toggle.setAttribute(
                    "aria-label",
                    node.hasChildren
                        ? state.expanded.has(node.id)
                            ? `Collapse ${node.label}`
                            : `Expand ${node.label}`
                        : `${node.label} has no children`
                );
                toggle.textContent =
                    node.hasChildren
                        ? state.expanded.has(node.id)
                            ? "−"
                            : "+"
                        : "·";

                if (node.hasChildren) {
                    toggle.addEventListener(
                        "click",
                        event => {
                            event.preventDefault();
                            event.stopPropagation();

                            if (
                                state.expanded.has(node.id)
                            ) {
                                state.expanded.delete(node.id);
                                emitExpansion("collapse", node);
                            } else {
                                state.expanded.add(node.id);
                                emitExpansion("expand", node);
                            }

                            renderer.metrics.expansions += 1;

                            state.focusedId = node.id;
                            renderTree({
                                restoreFocus: true
                            });
                        },
                        {
                            signal:
                                state.abortController.signal
                        }
                    );
                }

                const labelButton = createElement(
                    "button",
                    "terminal-tree-label"
                );
                labelButton.type = "button";
                labelButton.tabIndex = -1;
                labelButton.dataset.nodeId = node.id;
                labelButton.setAttribute(
                    "aria-label",
                    `${node.label}${node.hasChildren
                        ? `, ${node.childCount} children`
                        : ""}`
                );

                if (node.icon) {
                    const icon = createElement(
                        "span",
                        "terminal-tree-icon",
                        node.icon
                    );
                    icon.setAttribute(
                        "aria-hidden",
                        "true"
                    );
                    labelButton.appendChild(icon);
                }

                labelButton.appendChild(
                    createElement(
                        "span",
                        "terminal-tree-label-text",
                        node.label
                    )
                );

                if (node.status) {
                    labelButton.appendChild(
                        createElement(
                            "span",
                            "terminal-tree-status-badge",
                            node.status
                        )
                    );
                }

                if (
                    node.hasChildren &&
                    opts.showCounts !== false
                ) {
                    labelButton.appendChild(
                        createElement(
                            "span",
                            "terminal-tree-child-count",
                            String(node.childCount)
                        )
                    );
                }

                labelButton.addEventListener(
                    "click",
                    () => selectNode(node, item),
                    {
                        signal:
                            state.abortController.signal
                    }
                );

                labelButton.addEventListener(
                    "dblclick",
                    event => {
                        event.preventDefault();

                        if (!node.hasChildren) {
                            return;
                        }

                        if (
                            state.expanded.has(node.id)
                        ) {
                            state.expanded.delete(node.id);
                            emitExpansion("collapse", node);
                        } else {
                            state.expanded.add(node.id);
                            emitExpansion("expand", node);
                        }

                        renderer.metrics.expansions += 1;
                        state.focusedId = node.id;
                        renderTree({
                            restoreFocus: true
                        });
                    },
                    {
                        signal:
                            state.abortController.signal
                    }
                );

                row.addEventListener(
                    "keydown",
                    event => {
                        const rows = Array.from(
                            tree.querySelectorAll(
                                ".terminal-tree-row"
                            )
                        );
                        const index =
                            rows.indexOf(row);

                        if (event.key === "ArrowDown") {
                            event.preventDefault();
                            rows[index + 1]?.focus();
                            return;
                        }

                        if (event.key === "ArrowUp") {
                            event.preventDefault();
                            rows[index - 1]?.focus();
                            return;
                        }

                        if (event.key === "ArrowRight") {
                            event.preventDefault();

                            if (
                                node.hasChildren &&
                                !state.expanded.has(node.id)
                            ) {
                                state.expanded.add(node.id);
                                renderer.metrics.expansions += 1;
                                emitExpansion("expand", node);
                                state.focusedId = node.id;
                                renderTree({
                                    restoreFocus: true
                                });
                            } else {
                                const firstChild =
                                    item.querySelector(
                                        ":scope > .terminal-tree-children > .terminal-tree-node > .terminal-tree-row"
                                    );

                                firstChild?.focus();
                            }

                            return;
                        }

                        if (event.key === "ArrowLeft") {
                            event.preventDefault();

                            if (
                                node.hasChildren &&
                                state.expanded.has(node.id)
                            ) {
                                state.expanded.delete(node.id);
                                renderer.metrics.expansions += 1;
                                emitExpansion("collapse", node);
                                state.focusedId = node.id;
                                renderTree({
                                    restoreFocus: true
                                });
                            } else {
                                const parentItem =
                                    item.parentElement?.closest(
                                        ".terminal-tree-node"
                                    );

                                parentItem
                                    ?.querySelector(
                                        ":scope > .terminal-tree-row"
                                    )
                                    ?.focus();
                            }

                            return;
                        }

                        if (event.key === "Home") {
                            event.preventDefault();
                            rows[0]?.focus();
                            return;
                        }

                        if (event.key === "End") {
                            event.preventDefault();
                            rows[rows.length - 1]?.focus();
                            return;
                        }

                        if (
                            event.key === "Enter" ||
                            event.key === " "
                        ) {
                            event.preventDefault();
                            selectNode(node, item);
                        }
                    },
                    {
                        signal:
                            state.abortController.signal
                    }
                );

                row.addEventListener(
                    "focusin",
                    () => {
                        state.focusedId = node.id;

                        for (
                            const visibleRow of
                            tree.querySelectorAll(
                                ".terminal-tree-row"
                            )
                        ) {
                            visibleRow.tabIndex =
                                visibleRow === row
                                    ? 0
                                    : -1;
                        }
                    },
                    {
                        signal:
                            state.abortController.signal
                    }
                );

                row.append(
                    toggle,
                    labelButton
                );
                item.appendChild(row);

                if (
                    node.description &&
                    opts.showDescriptions !== false
                ) {
                    item.appendChild(
                        createElement(
                            "p",
                            "terminal-tree-description-text",
                            node.description
                        )
                    );
                }

                const metadata =
                    metadataElement(node);

                if (metadata) {
                    item.appendChild(metadata);
                }

                if (
                    node.hasChildren &&
                    state.expanded.has(node.id)
                ) {
                    const visibleChildren =
                        node.children.filter(
                            child =>
                                !state.hidden.has(child.id)
                        );
                    const childList = createElement(
                        "ul",
                        "terminal-tree-children"
                    );
                    childList.setAttribute(
                        "role",
                        "group"
                    );

                    visibleChildren.forEach(
                        (child, childIndex) => {
                            childList.appendChild(
                                createNodeElement(
                                    child,
                                    childIndex,
                                    visibleChildren.length
                                )
                            );
                        }
                    );

                    item.appendChild(childList);
                }

                if (
                    typeof opts.renderNode === "function"
                ) {
                    try {
                        const custom = opts.renderNode(
                            clone(node),
                            row,
                            item
                        );

                        if (isNode(custom)) {
                            row.replaceChildren(custom);
                        }
                    } catch (error) {
                        renderer._recordError(error);
                    }
                }

                return item;
            }

            function renderTree({
                restoreFocus = false
            } = {}) {
                if (state.destroyed) {
                    return;
                }

                tree.replaceChildren();

                const visibleRoots =
                    state.tree.roots.filter(
                        node =>
                            !state.hidden.has(node.id)
                    );
                const hasNodes =
                    visibleRoots.length > 0;

                tree.hidden = !hasNodes;
                empty.hidden = hasNodes;

                visibleRoots.forEach(
                    (node, index) => {
                        tree.appendChild(
                            createNodeElement(
                                node,
                                index,
                                visibleRoots.length
                            )
                        );
                    }
                );

                if (
                    !state.focusedId ||
                    !state.tree.byId.has(state.focusedId) ||
                    state.hidden.has(state.focusedId)
                ) {
                    state.focusedId =
                        visibleRoots[0]?.id || null;
                }

                if (state.focusedId) {
                    const focusedRow =
                        tree.querySelector(
                            `.terminal-tree-row[data-node-id="${CSS.escape(String(state.focusedId))}"]`
                        );

                    focusedRow?.setAttribute(
                        "tabindex",
                        "0"
                    );
                }

                const visibleCount =
                    state.tree.count -
                    state.hidden.size;

                status.textContent =
                    `${visibleCount} node${visibleCount === 1 ? "" : "s"}` +
                    (
                        state.query
                            ? ` matching “${state.query}”`
                            : ""
                    );

                summary.textContent =
                    `${state.tree.count} total node${state.tree.count === 1 ? "" : "s"}, ` +
                    `${state.expanded.size} expanded` +
                    (
                        state.tree.truncated
                            ? ", truncated"
                            : ""
                    );

                container.dataset.nodes =
                    String(state.tree.count);
                container.dataset.visibleNodes =
                    String(visibleCount);
                container.dataset.expandedNodes =
                    String(state.expanded.size);
                container.dataset.selectedNode =
                    state.selectedId || "";
                container.dataset.truncated =
                    state.tree.truncated
                        ? "true"
                        : "false";

                if (restoreFocus) {
                    window.requestAnimationFrame?.(
                        () =>
                            focusRowById(
                                state.focusedId
                            )
                    );
                }
            }

            function rebuildHeader() {
                state.controlsAbortController.abort();
                state.controlsAbortController =
                    new AbortController();

                header.replaceChildren();
                controls.replaceChildren();

                const opts = currentOptions();

                titleElement = null;
                descriptionElement = null;
                searchInput = null;

                if (opts.title) {
                    titleElement = createElement(
                        "h3",
                        "terminal-tree-title",
                        opts.title
                    );
                    header.appendChild(titleElement);
                }

                if (opts.description) {
                    descriptionElement = createElement(
                        "p",
                        "terminal-tree-description",
                        opts.description
                    );
                    header.appendChild(descriptionElement);
                }

                if (
                    opts.searchable !== false &&
                    state.tree.count
                ) {
                    const label = createElement(
                        "label",
                        "terminal-tree-search"
                    );

                    label.appendChild(
                        createElement(
                            "span",
                            "terminal-tree-search-label",
                            opts.searchLabel || "Filter"
                        )
                    );

                    searchInput =
                        document.createElement("input");
                    searchInput.type = "search";
                    searchInput.autocomplete = "off";
                    searchInput.spellcheck = false;
                    searchInput.value = state.query;
                    searchInput.placeholder =
                        opts.searchPlaceholder ||
                        "Filter tree…";
                    searchInput.setAttribute(
                        "aria-label",
                        opts.searchLabel ||
                        "Filter tree"
                    );

                    searchInput.addEventListener(
                        "input",
                        () => {
                            window.clearTimeout(
                                state.filterTimer
                            );

                            state.filterTimer =
                                window.setTimeout(
                                    () => {
                                        state.filterTimer = null;
                                        state.query =
                                            searchInput.value;
                                        filterTree();
                                        renderTree();

                                        renderer.metrics.filters += 1;

                                        safeDispatch(
                                            container,
                                            "terminal-tree-filter",
                                            {
                                                query:
                                                    state.query,
                                                matches:
                                                    state.matched.size,
                                                visible:
                                                    state.tree.count -
                                                    state.hidden.size
                                            }
                                        );

                                        renderer._emit(
                                            "filter",
                                            {
                                                query:
                                                    state.query,
                                                matches:
                                                    state.matched.size
                                            }
                                        );
                                    },
                                    parseNumber(
                                        opts.filterDebounce,
                                        DEFAULT_FILTER_DEBOUNCE,
                                        0,
                                        5000,
                                        true
                                    )
                                );
                        },
                        {
                            signal:
                                state.controlsAbortController.signal
                        }
                    );

                    label.appendChild(searchInput);
                    controls.appendChild(label);
                }

                if (
                    opts.expandControls !== false &&
                    state.tree.count
                ) {
                    const expandAllButton =
                        createElement(
                            "button",
                            "terminal-tree-expand-all",
                            opts.expandAllLabel ||
                            "Expand all"
                        );
                    expandAllButton.type = "button";

                    const collapseAllButton =
                        createElement(
                            "button",
                            "terminal-tree-collapse-all",
                            opts.collapseAllLabel ||
                            "Collapse all"
                        );
                    collapseAllButton.type = "button";

                    expandAllButton.addEventListener(
                        "click",
                        () => {
                            walkNodes(
                                state.tree.roots,
                                node => {
                                    if (node.hasChildren) {
                                        state.expanded.add(node.id);
                                    }
                                }
                            );

                            renderTree();
                            renderer.metrics.expansions += 1;
                            emitExpansion("expandAll");
                        },
                        {
                            signal:
                                state.controlsAbortController.signal
                        }
                    );

                    collapseAllButton.addEventListener(
                        "click",
                        () => {
                            state.expanded.clear();
                            renderTree();
                            renderer.metrics.expansions += 1;
                            emitExpansion("collapseAll");
                        },
                        {
                            signal:
                                state.controlsAbortController.signal
                        }
                    );

                    controls.append(
                        expandAllButton,
                        collapseAllButton
                    );
                }

                if (controls.childNodes.length) {
                    header.appendChild(controls);
                }

                header.appendChild(status);

                container.setAttribute(
                    "aria-label",
                    opts.ariaLabel ||
                    opts.title ||
                    "Terminal tree"
                );
                tree.setAttribute(
                    "aria-label",
                    opts.treeAriaLabel ||
                    opts.title ||
                    "Tree"
                );
                empty.textContent =
                    opts.emptyText ||
                    DEFAULT_EMPTY_TEXT;
            }

            applyInitialExpansion();
            rebuildHeader();
            filterTree();
            renderTree();

            const instance = {
                element:
                    container,

                state,

                refresh(
                    nextData = state.data,
                    nextOptions = {}
                ) {
                    if (state.destroyed) {
                        return container;
                    }

                    const previousQuery =
                        state.query;
                    const previousSelected =
                        state.selectedId;
                    const previousFocused =
                        state.focusedId;
                    const previousExpanded =
                        new Set(state.expanded);

                    state.options = {
                        ...state.options,
                        ...nextOptions
                    };
                    state.data = nextData;
                    state.tree =
                        normalizeTree(
                            nextData,
                            state.options
                        );

                    const keepFilter =
                        nextOptions.keepFilter === true;
                    const keepSelection =
                        nextOptions.keepSelection === true;
                    const keepExpansion =
                        nextOptions.keepExpansion === true;

                    state.query =
                        keepFilter
                            ? previousQuery
                            : "";
                    state.selectedId =
                        keepSelection &&
                        previousSelected &&
                        state.tree.byId.has(previousSelected)
                            ? previousSelected
                            : null;
                    state.focusedId =
                        previousFocused &&
                        state.tree.byId.has(previousFocused)
                            ? previousFocused
                            : null;

                    state.expanded.clear();

                    if (keepExpansion) {
                        for (const id of previousExpanded) {
                            if (
                                state.tree.byId.get(id)?.hasChildren
                            ) {
                                state.expanded.add(id);
                            }
                        }
                    } else {
                        applyInitialExpansion();
                    }

                    rebuildHeader();
                    filterTree();
                    renderTree();

                    renderer.metrics.refreshes += 1;

                    renderer._emit(
                        "refresh",
                        {
                            nodes:
                                state.tree.count,
                            truncated:
                                state.tree.truncated
                        }
                    );

                    return container;
                },

                setData(
                    nextData,
                    nextOptions = {}
                ) {
                    return instance.refresh(
                        nextData,
                        nextOptions
                    );
                },

                expand(
                    id,
                    recursive = false
                ) {
                    if (state.destroyed) {
                        return false;
                    }

                    const node =
                        state.tree.byId.get(
                            String(id)
                        );

                    if (!node) {
                        return false;
                    }

                    state.expanded.add(node.id);

                    if (recursive) {
                        walkNodes(
                            node.children,
                            child => {
                                if (child.hasChildren) {
                                    state.expanded.add(child.id);
                                }
                            }
                        );
                    }

                    state.focusedId = node.id;
                    renderTree();

                    renderer.metrics.expansions += 1;
                    emitExpansion(
                        recursive
                            ? "expandRecursive"
                            : "expand",
                        node
                    );

                    return true;
                },

                collapse(
                    id,
                    recursive = false
                ) {
                    if (state.destroyed) {
                        return false;
                    }

                    const node =
                        state.tree.byId.get(
                            String(id)
                        );

                    if (!node) {
                        return false;
                    }

                    state.expanded.delete(node.id);

                    if (recursive) {
                        walkNodes(
                            node.children,
                            child =>
                                state.expanded.delete(child.id)
                        );
                    }

                    state.focusedId = node.id;
                    renderTree();

                    renderer.metrics.expansions += 1;
                    emitExpansion(
                        recursive
                            ? "collapseRecursive"
                            : "collapse",
                        node
                    );

                    return true;
                },

                expandAll() {
                    if (state.destroyed) {
                        return 0;
                    }

                    walkNodes(
                        state.tree.roots,
                        node => {
                            if (node.hasChildren) {
                                state.expanded.add(node.id);
                            }
                        }
                    );

                    renderTree();
                    renderer.metrics.expansions += 1;
                    emitExpansion("expandAll");

                    return state.expanded.size;
                },

                collapseAll() {
                    if (state.destroyed) {
                        return 0;
                    }

                    const count =
                        state.expanded.size;

                    state.expanded.clear();
                    renderTree();

                    renderer.metrics.expansions += 1;
                    emitExpansion("collapseAll");

                    return count;
                },

                select(id) {
                    if (state.destroyed) {
                        return null;
                    }

                    const node =
                        state.tree.byId.get(
                            String(id)
                        );

                    if (!node) {
                        return null;
                    }

                    let parentId =
                        node.parentId;

                    while (parentId) {
                        state.expanded.add(parentId);
                        parentId =
                            state.tree.byId.get(parentId)
                                ?.parentId ||
                            null;
                    }

                    selectNode(node);
                    return clone(node);
                },

                find(query) {
                    if (state.destroyed) {
                        return [];
                    }

                    const normalizedQuery =
                        String(query || "")
                            .toLowerCase();
                    const results = [];

                    walkNodes(
                        state.tree.roots,
                        node => {
                            if (
                                nodeMatches(
                                    node,
                                    normalizedQuery
                                )
                            ) {
                                results.push(clone(node));
                            }
                        }
                    );

                    return results;
                },

                getNode(id) {
                    if (state.destroyed) {
                        return null;
                    }

                    const node =
                        state.tree.byId.get(
                            String(id)
                        );

                    return node
                        ? clone(node)
                        : null;
                },

                getSelected() {
                    if (state.destroyed) {
                        return null;
                    }

                    const node =
                        state.selectedId
                            ? state.tree.byId.get(
                                state.selectedId
                            )
                            : null;

                    return node
                        ? clone(node)
                        : null;
                },

                setFilter(query = "") {
                    if (state.destroyed) {
                        return {
                            matches: 0,
                            visible: 0
                        };
                    }

                    state.query = String(query);

                    if (searchInput) {
                        searchInput.value =
                            state.query;
                    }

                    filterTree();
                    renderTree();
                    renderer.metrics.filters += 1;

                    safeDispatch(
                        container,
                        "terminal-tree-filter",
                        {
                            query:
                                state.query,
                            matches:
                                state.matched.size,
                            visible:
                                state.tree.count -
                                state.hidden.size
                        }
                    );

                    return {
                        matches:
                            state.matched.size,
                        visible:
                            state.tree.count -
                            state.hidden.size
                    };
                },

                toJSON(
                    jsonOptions = {}
                ) {
                    function serialize(node) {
                        return {
                            id:
                                node.id,
                            label:
                                node.label,
                            description:
                                node.description,
                            type:
                                node.type,
                            status:
                                node.status,
                            icon:
                                node.icon,
                            metadata:
                                clone(node.metadata),
                            children:
                                node.children.map(serialize)
                        };
                    }

                    return safeStringify(
                        state.tree.roots.map(serialize),
                        {
                            space:
                                jsonOptions.compact === true
                                    ? 0
                                    : 2,
                            maxDepth:
                                parseNumber(
                                    jsonOptions.maxDepth,
                                    state.tree.maxDepth +
                                    DEFAULT_METADATA_DEPTH +
                                    4,
                                    1,
                                    4096,
                                    true
                                ),
                            maxEntries:
                                parseNumber(
                                    jsonOptions.maxEntries,
                                    state.tree.maxNodes,
                                    1,
                                    1000000,
                                    true
                                )
                        }
                    );
                },

                status() {
                    return {
                        version:
                            VERSION,
                        nodes:
                            state.tree.count,
                        visibleNodes:
                            state.tree.count -
                            state.hidden.size,
                        expandedNodes:
                            state.expanded.size,
                        selectedId:
                            state.selectedId,
                        focusedId:
                            state.focusedId,
                        query:
                            state.query,
                        matches:
                            state.matched.size,
                        truncated:
                            state.tree.truncated,
                        cycles:
                            state.tree.cycles,
                        maxDepth:
                            state.tree.maxDepth,
                        maxNodes:
                            state.tree.maxNodes,
                        destroyed:
                            state.destroyed
                    };
                },

                destroy() {
                    if (state.destroyed) {
                        return false;
                    }

                    window.clearTimeout(
                        state.filterTimer
                    );

                    state.controlsAbortController.abort();
                    state.abortController.abort();
                    state.destroyed = true;

                    renderer.instances.delete(instance);

                    if (
                        container[INSTANCE_SYMBOL] ===
                        instance
                    ) {
                        delete container[INSTANCE_SYMBOL];
                    }

                    delete container.treeInstance;
                    delete container.update;
                    delete container.setData;
                    delete container.destroy;

                    container.remove();

                    renderer.metrics.destroyedInstances += 1;

                    renderer._emit(
                        "instance-destroy",
                        {}
                    );

                    return true;
                }
            };

            container.treeInstance = instance;
            container[INSTANCE_SYMBOL] = instance;
            container.update = instance.refresh;
            container.setData = instance.setData;
            container.destroy = instance.destroy;

            renderer.instances.add(instance);
            renderer.metrics.renders += 1;

            renderer._emit(
                "render",
                {
                    nodes:
                        state.tree.count,
                    truncated:
                        state.tree.truncated,
                    element:
                        container
                }
            );

            return container;
        }

        activeInstance() {
            const root =
                this.context.root ||
                document;

            const element =
                root.querySelector?.(
                    ".terminal-renderer-tree"
                ) ||
                document.querySelector(
                    ".terminal-renderer-tree"
                );

            const direct =
                element?.[INSTANCE_SYMBOL] ||
                element?.treeInstance ||
                null;

            if (
                direct &&
                !direct.state?.destroyed
            ) {
                return direct;
            }

            const instances =
                Array.from(this.instances)
                    .filter(
                        instance =>
                            !instance.state?.destroyed
                    );

            return instances.length
                ? instances[instances.length - 1]
                : null;
        }

        mount(
            target,
            data,
            options = {}
        ) {
            this.assertActive();

            if (!isElement(target)) {
                throw new TypeError(
                    "Tree renderer mount target must be an element."
                );
            }

            const element =
                this.render(data, options);

            target.replaceChildren(element);
            return element;
        }

        status() {
            return {
                name:
                    "tree",
                module:
                    MODULE_NAME,
                version:
                    VERSION,
                instances:
                    this.instances.size,
                metrics: {
                    ...this.metrics
                },
                active:
                    this.activeInstance()
                        ?.status?.() ||
                    null,
                lastError:
                    this.lastError
                        ? {
                            name:
                                this.lastError.name,
                            message:
                                this.lastError.message
                        }
                        : null,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            for (
                const instance of
                Array.from(this.instances)
            ) {
                instance.destroy();
            }

            this.instances.clear();

            const root =
                this.context.root ||
                document;

            if (
                root?.[RENDERER_SYMBOL] ===
                this
            ) {
                delete root[RENDERER_SYMBOL];
            }

            this.destroyed = true;

            safeDispatch(
                this,
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            safeDispatch(
                document,
                "speciedex:terminal-tree-destroy",
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
        options = {}
    ) {
        const renderer =
            new TreeRenderer({});
        const element =
            renderer.render(data, options);

        const originalDestroy =
            element.destroy;

        element.destroy = () => {
            const result =
                originalDestroy?.();

            renderer.destroy();
            return result;
        };

        return element;
    }

    function initialize(
        context = {}
    ) {
        const root =
            context.root ||
            document;

        const existing =
            context.treeRenderer instanceof TreeRenderer
                ? context.treeRenderer
                : context.renderers?.get?.("tree") ||
                  root?.[RENDERER_SYMBOL];

        if (
            existing instanceof TreeRenderer &&
            !existing.destroyed
        ) {
            context.treeRenderer = existing;

            context.registerRenderer?.(
                "tree",
                existing
            );
            context.registerVisualization?.(
                "tree",
                existing
            );

            return existing;
        }

        const renderer =
            new TreeRenderer(context);

        try {
            root[RENDERER_SYMBOL] = renderer;
        } catch (_error) {
            /* Symbol registration is advisory. */
        }

        context.treeRenderer = renderer;

        context.registerRenderer?.(
            "tree",
            renderer
        );
        context.registerVisualization?.(
            "tree",
            renderer
        );

        safeDispatch(
            document,
            "speciedex:terminal-tree-ready",
            {
                renderer,
                version:
                    VERSION
            }
        );

        return renderer;
    }

    function getRenderer(context) {
        return (
            context.treeRenderer ||
            context.renderers?.get?.("tree") ||
            context.services?.get?.("tree") ||
            null
        );
    }

    const commands = [
        {
            name:
                "tree-status",
            category:
                "visualization",
            description:
                "Display tree-renderer diagnostics.",
            usage:
                "tree-status",
            handler: ({
                context,
                writeJSON
            }) => {
                const renderer =
                    getRenderer(context);

                return writeJSON(
                    renderer?.status?.() ||
                    null
                );
            }
        },

        {
            name:
                "tree-filter",
            category:
                "visualization",
            description:
                "Filter the active tree.",
            usage:
                "tree-filter [query]",
            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const instance =
                    getRenderer(context)
                        ?.activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active tree renderer is available."
                    );
                }

                const query =
                    args.join(" ");

                return writeJSON({
                    query,
                    ...instance.setFilter(query)
                });
            }
        },

        {
            name:
                "tree-expand",
            category:
                "visualization",
            description:
                "Expand a node in the active tree.",
            usage:
                "tree-expand <id> [--recursive]",
            handler: ({
                args = [],
                parsed = {
                    flags: {}
                },
                context,
                writeJSON
            }) => {
                const instance =
                    getRenderer(context)
                        ?.activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active tree renderer is available."
                    );
                }

                if (!args[0]) {
                    throw new Error(
                        "Usage: tree-expand <id> [--recursive]"
                    );
                }

                const expanded =
                    instance.expand(
                        args[0],
                        Boolean(
                            parsed.flags.recursive
                        )
                    );

                if (!expanded) {
                    throw new Error(
                        `Tree node not found: ${args[0]}`
                    );
                }

                return writeJSON({
                    expanded:
                        true,
                    id:
                        args[0],
                    recursive:
                        Boolean(
                            parsed.flags.recursive
                        )
                });
            }
        },

        {
            name:
                "tree-collapse",
            category:
                "visualization",
            description:
                "Collapse a node in the active tree.",
            usage:
                "tree-collapse <id> [--recursive]",
            handler: ({
                args = [],
                parsed = {
                    flags: {}
                },
                context,
                writeJSON
            }) => {
                const instance =
                    getRenderer(context)
                        ?.activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active tree renderer is available."
                    );
                }

                if (!args[0]) {
                    throw new Error(
                        "Usage: tree-collapse <id> [--recursive]"
                    );
                }

                const collapsed =
                    instance.collapse(
                        args[0],
                        Boolean(
                            parsed.flags.recursive
                        )
                    );

                if (!collapsed) {
                    throw new Error(
                        `Tree node not found: ${args[0]}`
                    );
                }

                return writeJSON({
                    collapsed:
                        true,
                    id:
                        args[0],
                    recursive:
                        Boolean(
                            parsed.flags.recursive
                        )
                });
            }
        },

        {
            name:
                "tree-select",
            category:
                "visualization",
            description:
                "Select a node in the active tree.",
            usage:
                "tree-select <id>",
            handler: ({
                args = [],
                context,
                writeJSON
            }) => {
                const instance =
                    getRenderer(context)
                        ?.activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active tree renderer is available."
                    );
                }

                if (!args[0]) {
                    throw new Error(
                        "Usage: tree-select <id>"
                    );
                }

                const selected =
                    instance.select(args[0]);

                if (!selected) {
                    throw new Error(
                        `Tree node not found: ${args[0]}`
                    );
                }

                return writeJSON(selected);
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
        TreeRenderer,
        clone,
        safeStringify,
        getChildCollection,
        normalizeNode,
        normalizeTree,
        walkNodes,
        nodeMatches,
        render,
        initialize,
        mount:
            initialize,
        init:
            initialize,
        setup:
            initialize,
        commands
    });

    window.SpeciedexTerminalTree = api;
    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};
    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name:
                        MODULE_NAME,
                    module:
                        api
                }
            }
        )
    );
})(window, document);
