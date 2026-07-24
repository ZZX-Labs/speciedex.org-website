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
    const VERSION = "2.1.0";

    const RENDERER_SYMBOL =
        Symbol.for(
            "speciedex.terminal.tree.renderer"
        );

    const INSTANCE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.tree.instance"
        );

    const DEFAULT_MAX_DEPTH = 64;
    const DEFAULT_MAX_NODES = 10000;
    const DEFAULT_EMPTY_TEXT = "No tree data.";
    const DEFAULT_FILTER_DEBOUNCE = 120;
    const DEFAULT_METADATA_LIMIT = 128;
    const DEFAULT_METADATA_DEPTH = 8;

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
        return new Date(timestamp).toISOString();
    }

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function clone(
        value,
        seen =
            new WeakMap()
    ) {
        if (
            value ===
                undefined ||
            value ===
                null ||
            typeof value !==
                "object"
        ) {
            return value;
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
            value instanceof
                RegExp
        ) {
            return new RegExp(
                value.source,
                value.flags
            );
        }

        if (
            value instanceof
                Map
        ) {
            const output =
                new Map();

            seen.set(
                value,
                output
            );

            for (
                const [
                    key,
                    item
                ] of value
            ) {
                output.set(
                    clone(
                        key,
                        seen
                    ),
                    clone(
                        item,
                        seen
                    )
                );
            }

            return output;
        }

        if (
            value instanceof
                Set
        ) {
            const output =
                new Set();

            seen.set(
                value,
                output
            );

            for (
                const item of
                value
            ) {
                output.add(
                    clone(
                        item,
                        seen
                    )
                );
            }

            return output;
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
                        seen
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
                    seen
                );
        }

        return output;
    }

    function isNode(
        value
    ) {
        return Boolean(
            value &&
            typeof value.nodeType ===
                "number"
        );
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

    function parseBoolean(value, fallback = false) {
        if (typeof value === "boolean") {
            return value;
        }

        if (value === undefined || value === null || value === "") {
            return fallback;
        }

        return ["1", "true", "yes", "on", "enabled"].includes(
            String(value).trim().toLowerCase()
        );
    }

    function parseNumber(value, fallback, minimum = -Infinity, maximum = Infinity) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, number));
    }

    function normalizeText(value, fallback = "") {
        if (value === undefined || value === null) {
            return fallback;
        }

        return String(value).trim();
    }

    function safeDispatch(
        target,
        name,
        detail
    ) {
        if (
            !target ||
            typeof target.dispatchEvent !==
                "function"
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

    function createElement(tagName, className, text) {
        const element = document.createElement(tagName);

        if (className) {
            element.className = className;
        }

        if (text !== undefined) {
            element.textContent = text;
        }

        return element;
    }

    function getChildCollection(value, options = {}) {
        if (!isObject(value)) {
            return null;
        }

        const childKeys = Array.isArray(options.childKeys) && options.childKeys.length
            ? options.childKeys
            : DEFAULT_CHILD_KEYS;

        for (const key of childKeys) {
            if (Array.isArray(value[key])) {
                return {
                    key,
                    children: value[key]
                };
            }

            if (isObject(value[key])) {
                return {
                    key,
                    children: Object.entries(value[key]).map(([name, child]) => {
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

            if (candidate !== undefined && candidate !== null && candidate !== "") {
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
            "children",
            "nodes",
            "items",
            "branches",
            "descendants",
            "taxa",
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
            "__treeKey"
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
            typeof value ===
                "object"
        ) {
            if (
                state.seen.has(
                    value
                )
            ) {
                state.truncated =
                    true;

                return null;
            }

            state.seen.add(
                value
            );
        }

        if (state.nodeCount >= state.maxNodes) {
            state.truncated = true;
            return null;
        }

        if (depth > state.maxDepth) {
            state.truncated = true;
            return null;
        }

        const fallbackLabel = `Node ${state.nodeCount + 1}`;
        const label = inferLabel(value, fallbackLabel);
        const requestedId =
            inferId(
                value,
                path,
                fallbackLabel
            );

        let id =
            requestedId;

        let duplicateIndex =
            1;

        while (
            state.byId.has(
                id
            )
        ) {
            duplicateIndex +=
                1;

            id =
                `${requestedId}:${duplicateIndex}`;
        }
        const childCollection = getChildCollection(value, options);
        const childValues = childCollection?.children || [];

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
            status: isObject(value) && value.status !== undefined
                ? normalizeText(value.status)
                : null,
            icon: isObject(value) && value.icon !== undefined
                ? normalizeText(value.icon)
                : null,
            metadata: extractMetadata(value, childCollection?.key),
            raw: clone(value),
            children: [],
            hasChildren: childValues.length > 0,
            childCount: childValues.length
        };

        state.nodeCount += 1;
        state.byId.set(node.id, node);
        state.byPath.set(node.path, node);

        for (let childIndex = 0; childIndex < childValues.length; childIndex += 1) {
            const child = childValues[childIndex];
            const childLabel = inferLabel(child, String(childIndex));
            const safeSegment = String(childLabel || childIndex)
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

    function normalizeTree(data, options = {}) {
        const maxDepth = parseNumber(
            options.maxDepth,
            DEFAULT_MAX_DEPTH,
            0,
            1024
        );
        const maxNodes = parseNumber(
            options.maxNodes,
            DEFAULT_MAX_NODES,
            1,
            1000000
        );

        const state = {
            maxDepth,
            maxNodes,
            nodeCount: 0,
            truncated: false,
            byId: new Map(),
            byPath:
                new Map(),
            seen:
                new WeakSet()
        };

        let roots;

        if (Array.isArray(data)) {
            roots = data;
        } else if (isObject(data)) {
            const childCollection = getChildCollection(data, options);

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
                roots = Object.entries(data).map(([key, value]) => {
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
        } else if (data === null || data === undefined) {
            roots = [];
        } else {
            roots = [data];
        }

        const normalizedRoots = [];

        for (let index = 0; index < roots.length; index += 1) {
            const value = roots[index];
            const label = inferLabel(value, `root-${index + 1}`);
            const path = String(label || index).replace(/[./\\]/g, "_");
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
            byId: state.byId,
            byPath: state.byPath,
            maxDepth,
            maxNodes
        };
    }

    function walkNodes(nodes, callback) {
        for (const node of nodes) {
            callback(node);

            if (node.children.length) {
                walkNodes(node.children, callback);
            }
        }
    }

    function nodeMatches(node, query) {
        if (!query) {
            return true;
        }

        let metadata =
            "";

        try {
            metadata =
                JSON.stringify(
                    node.metadata
                );
        } catch (_error) {
            metadata =
                "";
        }

        const haystack = [
            node.id,
            node.label,
            node.description,
            node.type,
            node.status,
            metadata
        ].join(" ").toLowerCase();

        return haystack.includes(query);
    }

    class TreeRenderer extends EventTarget {
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
                filters:
                    0,
                expansions:
                    0,
                selections:
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
                    "Tree renderer has been destroyed."
                );
            }
        }

        _emit(type, detail = {}) {
            if (
                this.destroyed &&
                type !==
                    "destroy"
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
                this.context.events?.emit?.(`tree:${type}`, event);
            } catch (error) {
                /* Context event bus is optional. */
            }

            return event;
        }

        render(
            data,
            options =
                {}
        ) {
            this.assertActive();

            const normalized =
                normalizeTree(
                    data,
                    options
                );
            const state = {
                tree: normalized,
                expanded: new Set(),
                selectedId: null,
                focusedId: null,
                query: "",
                matched: new Set(),
                hidden:
                    new Set(),
                destroyed:
                    false,
                abortController:
                    new AbortController(),
                filterTimer:
                    null,
                options: {
                    ...options
                }
            };

            const defaultExpandedDepth = parseNumber(
                options.expandedDepth,
                options.collapsed === true ? -1 : 1,
                -1,
                normalized.maxDepth
            );

            walkNodes(normalized.roots, (node) => {
                if (
                    node.hasChildren &&
                    node.depth <= defaultExpandedDepth
                ) {
                    state.expanded.add(node.id);
                }
            });

            const container = createElement(
                "section",
                "terminal-renderer terminal-renderer-tree"
            );
            container.dataset.renderer =
                "tree";

            container[
                INSTANCE_SYMBOL
            ] =
                null;
            container.dataset.nodes = String(normalized.count);
            container.dataset.truncated = normalized.truncated ? "true" : "false";
            container.setAttribute("role", "region");
            container.setAttribute(
                "aria-label",
                options.ariaLabel || options.title || "Terminal tree"
            );

            const header = createElement(
                "header",
                "terminal-tree-header"
            );

            if (options.title) {
                header.appendChild(
                    createElement(
                        "h3",
                        "terminal-tree-title",
                        options.title
                    )
                );
            }

            if (options.description) {
                header.appendChild(
                    createElement(
                        "p",
                        "terminal-tree-description",
                        options.description
                    )
                );
            }

            const controls = createElement(
                "div",
                "terminal-tree-controls"
            );

            let searchInput = null;

            if (options.searchable !== false && normalized.count) {
                const label = createElement(
                    "label",
                    "terminal-tree-search"
                );
                label.appendChild(
                    createElement(
                        "span",
                        "terminal-tree-search-label",
                        options.searchLabel || "Filter"
                    )
                );

                searchInput = document.createElement("input");
                searchInput.type = "search";
                searchInput.autocomplete = "off";
                searchInput.spellcheck = false;
                searchInput.placeholder =
                    options.searchPlaceholder || "Filter tree…";
                searchInput.setAttribute(
                    "aria-label",
                    options.searchLabel || "Filter tree"
                );

                label.appendChild(searchInput);
                controls.appendChild(label);
            }

            if (options.expandControls !== false && normalized.count) {
                const expandAllButton = createElement(
                    "button",
                    "terminal-tree-expand-all",
                    options.expandAllLabel || "Expand all"
                );
                expandAllButton.type = "button";

                const collapseAllButton = createElement(
                    "button",
                    "terminal-tree-collapse-all",
                    options.collapseAllLabel || "Collapse all"
                );
                collapseAllButton.type = "button";

                controls.append(expandAllButton, collapseAllButton);

                expandAllButton.addEventListener(
                    "click",
                    () => {
                    walkNodes(state.tree.roots, (node) => {
                        if (node.hasChildren) {
                            state.expanded.add(node.id);
                        }
                    });

                    renderTree();
                    this.metrics.expansions +=
                        1;

                    emitExpansion(
                        "expandAll"
                    );
                },
                {
                    signal:
                        state.abortController.signal
                }
                );

                collapseAllButton.addEventListener(
                    "click",
                    () => {
                    state.expanded.clear();
                    renderTree();
                    this.metrics.expansions +=
                        1;

                    emitExpansion(
                        "collapseAll"
                    );
                },
                {
                    signal:
                        state.abortController.signal
                }
                );
            }

            if (controls.childNodes.length) {
                header.appendChild(controls);
            }

            const status = createElement(
                "div",
                "terminal-tree-status"
            );
            status.setAttribute("aria-live", "polite");
            header.appendChild(status);
            container.appendChild(header);

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
            tree.setAttribute(
                "aria-label",
                options.treeAriaLabel || options.title || "Tree"
            );

            viewport.appendChild(tree);
            container.appendChild(viewport);

            const empty = createElement(
                "div",
                "terminal-tree-empty",
                options.emptyText || DEFAULT_EMPTY_TEXT
            );
            empty.hidden = true;
            container.appendChild(empty);

            const footer = createElement(
                "footer",
                "terminal-tree-footer"
            );
            const summary = createElement(
                "div",
                "terminal-tree-summary"
            );
            footer.appendChild(summary);
            container.appendChild(footer);

            function emitExpansion(type, node = null) {
                safeDispatch(container, "terminal-tree-expansion", {
                    type,
                    node: node ? clone(node) : null,
                    expanded: Array.from(state.expanded)
                });
            }

            function filterTree() {
                state.matched.clear();
                state.hidden.clear();

                const query = state.query.trim().toLowerCase();

                if (!query) {
                    return;
                }

                const includeAncestors = new Set();

                function visit(node, ancestors) {
                    const matches = nodeMatches(node, query);

                    if (matches) {
                        state.matched.add(node.id);

                        for (const ancestor of ancestors) {
                            includeAncestors.add(ancestor.id);
                            state.expanded.add(ancestor.id);
                        }
                    }

                    for (const child of node.children) {
                        visit(child, [...ancestors, node]);
                    }
                }

                for (const root of state.tree.roots) {
                    visit(root, []);
                }

                walkNodes(state.tree.roots, (node) => {
                    if (
                        !state.matched.has(node.id) &&
                        !includeAncestors.has(node.id)
                    ) {
                        const hasMatchedDescendant = (() => {
                            let found = false;

                            walkNodes(node.children, (child) => {
                                if (state.matched.has(child.id)) {
                                    found = true;
                                }
                            });

                            return found;
                        })();

                        if (!hasMatchedDescendant) {
                            state.hidden.add(node.id);
                        }
                    }
                });
            }

            function metadataElement(node) {
                const entries =
                    Object.entries(
                        node.metadata ||
                        {}
                    ).slice(
                        0,
                        parseNumber(
                            options.metadataLimit,
                            DEFAULT_METADATA_LIMIT,
                            0,
                            10000
                        )
                    );

                if (
                    options.showMetadata === false ||
                    !entries.length
                ) {
                    return null;
                }

                const details = createElement(
                    "details",
                    "terminal-tree-metadata"
                );
                const detailsSummary = createElement(
                    "summary",
                    "terminal-tree-metadata-summary",
                    options.metadataLabel || "Details"
                );
                const definitionList = createElement(
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

                    if (
                        isNode(
                            value
                        )
                    ) {
                        description.appendChild(value);
                    } else if (isObject(value) || Array.isArray(value)) {
                        description.appendChild(
                            createElement(
                                "pre",
                                "terminal-tree-metadata-json",
                                JSON.stringify(value, null, 2)
                            )
                        );
                    } else {
                        description.textContent = String(value ?? "");
                    }

                    definitionList.append(term, description);
                }

                details.append(detailsSummary, definitionList);
                return details;
            }

            function createNodeElement(node, siblingIndex, siblingCount) {
                const item = createElement(
                    "li",
                    "terminal-tree-node"
                );
                item.dataset.nodeId = node.id;
                item.dataset.path = node.path;
                item.dataset.depth = String(node.depth);
                item.dataset.type = node.type || "node";
                item.setAttribute("role", "treeitem");
                item.setAttribute("aria-level", String(node.depth + 1));
                item.setAttribute("aria-posinset", String(siblingIndex + 1));
                item.setAttribute("aria-setsize", String(siblingCount));

                if (node.status) {
                    item.dataset.status = node.status;
                }

                if (node.hasChildren) {
                    item.setAttribute(
                        "aria-expanded",
                        state.expanded.has(node.id) ? "true" : "false"
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
                row.tabIndex = state.focusedId === node.id ? 0 : -1;

                const toggle = createElement(
                    "button",
                    "terminal-tree-toggle"
                );
                toggle.type = "button";
                toggle.setAttribute("aria-label", node.hasChildren
                    ? state.expanded.has(node.id)
                        ? `Collapse ${node.label}`
                        : `Expand ${node.label}`
                    : `${node.label} has no children`
                );
                toggle.disabled = !node.hasChildren;
                toggle.setAttribute("aria-hidden", node.hasChildren ? "false" : "true");
                toggle.textContent = node.hasChildren
                    ? state.expanded.has(node.id)
                        ? "−"
                        : "+"
                    : "·";

                if (node.hasChildren) {
                    toggle.addEventListener(
                        "click",
                        event => {
                        event.stopPropagation();

                        if (state.expanded.has(node.id)) {
                            state.expanded.delete(node.id);
                            emitExpansion("collapse", node);
                        } else {
                            state.expanded.add(node.id);
                            emitExpansion("expand", node);
                        }

                        this.metrics.expansions +=
                            1;

                        renderTree();
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
                labelButton.dataset.nodeId = node.id;
                labelButton.setAttribute(
                    "aria-label",
                    `${node.label}${node.hasChildren ? `, ${node.childCount} children` : ""}`
                );

                if (node.icon) {
                    const icon = createElement(
                        "span",
                        "terminal-tree-icon",
                        node.icon
                    );
                    icon.setAttribute("aria-hidden", "true");
                    labelButton.appendChild(icon);
                }

                const text = createElement(
                    "span",
                    "terminal-tree-label-text",
                    node.label
                );
                labelButton.appendChild(text);

                if (node.status) {
                    labelButton.appendChild(
                        createElement(
                            "span",
                            "terminal-tree-status-badge",
                            node.status
                        )
                    );
                }

                if (node.hasChildren && options.showCounts !== false) {
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
                    () => {
                    state.selectedId = node.id;
                    state.focusedId = node.id;
                    renderTree();

                    if (typeof options.onSelect === "function") {
                        options.onSelect(clone(node), item);
                    }

                    this.metrics.selections +=
                        1;

                    safeDispatch(
                        container,
                        "terminal-tree-select",
                        {
                            node:
                                clone(
                                    node
                                )
                        }
                    );
                },
                {
                    signal:
                        state.abortController.signal
                }
                );

                labelButton.addEventListener(
                    "dblclick",
                    () => {
                    if (!node.hasChildren) {
                        return;
                    }

                    if (state.expanded.has(node.id)) {
                        state.expanded.delete(node.id);
                    } else {
                        state.expanded.add(node.id);
                    }

                    this.metrics.expansions +=
                        1;

                    renderTree();
                },
                {
                    signal:
                        state.abortController.signal
                }
                );

                row.addEventListener(
                    "keydown",
                    event => {
                    const visibleRows = Array.from(
                        tree.querySelectorAll(".terminal-tree-row")
                    );
                    const currentIndex = visibleRows.indexOf(row);

                    if (event.key === "ArrowDown") {
                        event.preventDefault();
                        visibleRows[currentIndex + 1]?.focus();
                    } else if (event.key === "ArrowUp") {
                        event.preventDefault();
                        visibleRows[currentIndex - 1]?.focus();
                    } else if (event.key === "ArrowRight") {
                        event.preventDefault();

                        if (node.hasChildren && !state.expanded.has(node.id)) {
                            state.expanded.add(node.id);
                            renderTree();
                        } else {
                            const firstChild = item.querySelector(
                                ":scope > .terminal-tree-children > .terminal-tree-node .terminal-tree-row"
                            );
                            firstChild?.focus();
                        }
                    } else if (event.key === "ArrowLeft") {
                        event.preventDefault();

                        if (node.hasChildren && state.expanded.has(node.id)) {
                            state.expanded.delete(node.id);
                            renderTree();
                        } else {
                            const parentItem = item.parentElement?.closest(
                                ".terminal-tree-node"
                            );
                            parentItem?.querySelector(":scope > .terminal-tree-row")?.focus();
                        }
                    } else if (event.key === "Home") {
                        event.preventDefault();
                        visibleRows[0]?.focus();
                    } else if (event.key === "End") {
                        event.preventDefault();
                        visibleRows[visibleRows.length - 1]?.focus();
                    } else if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        labelButton.click();
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

                    for (const visibleRow of tree.querySelectorAll(".terminal-tree-row")) {
                        visibleRow.tabIndex =
                            visibleRow ===
                                row
                                ? 0
                                : -1;
                    }
                },
                {
                    signal:
                        state.abortController.signal
                }
                );

                row.append(toggle, labelButton);
                item.appendChild(row);

                if (node.description && options.showDescriptions !== false) {
                    item.appendChild(
                        createElement(
                            "p",
                            "terminal-tree-description-text",
                            node.description
                        )
                    );
                }

                const metadata = metadataElement(node);

                if (metadata) {
                    item.appendChild(metadata);
                }

                if (
                    node.hasChildren &&
                    state.expanded.has(node.id)
                ) {
                    const childList = createElement(
                        "ul",
                        "terminal-tree-children"
                    );
                    childList.setAttribute("role", "group");

                    node.children.forEach((child, childIndex) => {
                        if (!state.hidden.has(child.id)) {
                            childList.appendChild(
                                createNodeElement(
                                    child,
                                    childIndex,
                                    node.children.length
                                )
                            );
                        }
                    });

                    item.appendChild(childList);
                }

                if (typeof options.renderNode === "function") {
                    try {
                        const custom = options.renderNode(
                            clone(node),
                            row,
                            item
                        );

                        if (
                            isNode(
                                custom
                            )
                        ) {
                            row.replaceChildren(custom);
                        }
                    } catch (error) {
                        /* Fall back to default rendering. */
                    }
                }

                return item;
            }

            function renderTree() {
                tree.replaceChildren();

                const visibleRoots = state.tree.roots.filter(
                    (node) => !state.hidden.has(node.id)
                );
                const hasNodes = visibleRoots.length > 0;

                tree.hidden = !hasNodes;
                empty.hidden = hasNodes;

                visibleRoots.forEach((node, index) => {
                    tree.appendChild(
                        createNodeElement(
                            node,
                            index,
                            visibleRoots.length
                        )
                    );
                });

                if (!state.focusedId && visibleRoots.length) {
                    state.focusedId = visibleRoots[0].id;
                    tree.querySelector(".terminal-tree-row")?.setAttribute(
                        "tabindex",
                        "0"
                    );
                }

                const visibleCount = state.tree.count - state.hidden.size;

                status.textContent =
                    `${visibleCount} node${visibleCount === 1 ? "" : "s"}` +
                    (state.query
                        ? ` matching “${state.query}”`
                        : "");

                summary.textContent =
                    `${state.tree.count} total node${state.tree.count === 1 ? "" : "s"}, ` +
                    `${state.expanded.size} expanded` +
                    (state.tree.truncated ? ", truncated" : "");

                container.dataset.visibleNodes = String(visibleCount);
                container.dataset.expandedNodes = String(state.expanded.size);
                container.dataset.selectedNode = state.selectedId || "";
            }

            if (
                searchInput
            ) {
                searchInput.addEventListener(
                    "input",
                    () => {
                        window.clearTimeout(
                            state.filterTimer
                        );

                        state.filterTimer =
                            window.setTimeout(
                                () => {
                                    state.filterTimer =
                                        null;

                                    state.query =
                                        searchInput.value;

                                    filterTree();
                                    renderTree();

                                    this.metrics.filters +=
                                        1;

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
                                },
                                parseNumber(
                                    options.filterDebounce,
                                    DEFAULT_FILTER_DEBOUNCE,
                                    0,
                                    5000
                                )
                            );
                    },
                    {
                        signal:
                            state.abortController.signal
                    }
                );
            }

            filterTree();
            renderTree();

            const instance = {
                element:
                    container,

                state,

                refresh:
                    (
                        nextData =
                            data,
                        nextOptions =
                            {}
                    ) => {
                        if (
                            state.destroyed
                        ) {
                            return container;
                        }

                        state.options = {
                            ...state.options,
                            ...nextOptions
                        };

                        state.tree =
                            normalizeTree(
                                nextData,
                                state.options
                            );

                        state.expanded.clear();

                        state.selectedId =
                            null;

                        state.focusedId =
                            null;

                        if (
                            nextOptions.keepFilter !==
                                true
                        ) {
                            state.query =
                                "";

                            if (
                                searchInput
                            ) {
                                searchInput.value =
                                    "";
                            }
                        }

                        const expandedDepth =
                            parseNumber(
                                state.options.expandedDepth,
                                state.options.collapsed ===
                                    true
                                    ? -1
                                    : 1,
                                -1,
                                state.tree.maxDepth
                            );

                        walkNodes(
                            state.tree.roots,
                            node => {
                                if (
                                    node.hasChildren &&
                                    node.depth <=
                                        expandedDepth
                                ) {
                                    state.expanded.add(
                                        node.id
                                    );
                                }
                            }
                        );

                        filterTree();
                        renderTree();

                        container.dataset.nodes =
                            String(
                                state.tree.count
                            );

                        container.dataset.truncated =
                            state.tree.truncated
                                ? "true"
                                : "false";

                        this.metrics.refreshes +=
                            1;

                        this._emit(
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

                expand:
                    (
                        id,
                        recursive =
                            false
                    ) => {
                        const node =
                            state.tree.byId.get(
                                String(
                                    id
                                )
                            );

                        if (!node) {
                            return false;
                        }

                        state.expanded.add(
                            node.id
                        );

                        if (
                            recursive
                        ) {
                            walkNodes(
                                node.children,
                                child => {
                                    if (
                                        child.hasChildren
                                    ) {
                                        state.expanded.add(
                                            child.id
                                        );
                                    }
                                }
                            );
                        }

                        renderTree();

                        this.metrics.expansions +=
                            1;

                        return true;
                    },

                collapse:
                    (
                        id,
                        recursive =
                            false
                    ) => {
                        const node =
                            state.tree.byId.get(
                                String(
                                    id
                                )
                            );

                        if (!node) {
                            return false;
                        }

                        state.expanded.delete(
                            node.id
                        );

                        if (
                            recursive
                        ) {
                            walkNodes(
                                node.children,
                                child => {
                                    state.expanded.delete(
                                        child.id
                                    );
                                }
                            );
                        }

                        renderTree();

                        this.metrics.expansions +=
                            1;

                        return true;
                    },

                expandAll:
                    () => {
                        walkNodes(
                            state.tree.roots,
                            node => {
                                if (
                                    node.hasChildren
                                ) {
                                    state.expanded.add(
                                        node.id
                                    );
                                }
                            }
                        );

                        renderTree();

                        this.metrics.expansions +=
                            1;

                        return state.expanded.size;
                    },

                collapseAll:
                    () => {
                        const count =
                            state.expanded.size;

                        state.expanded.clear();

                        renderTree();

                        this.metrics.expansions +=
                            1;

                        return count;
                    },

                select:
                    id => {
                        const node =
                            state.tree.byId.get(
                                String(
                                    id
                                )
                            );

                        if (!node) {
                            return null;
                        }

                        state.selectedId =
                            node.id;

                        state.focusedId =
                            node.id;

                        let parentId =
                            node.parentId;

                        while (
                            parentId
                        ) {
                            state.expanded.add(
                                parentId
                            );

                            parentId =
                                state.tree.byId.get(
                                    parentId
                                )?.parentId ||
                                null;
                        }

                        renderTree();

                        this.metrics.selections +=
                            1;

                        return clone(
                            node
                        );
                    },

                find:
                    query => {
                        const normalizedQuery =
                            String(
                                query ||
                                ""
                            ).toLowerCase();

                        const results =
                            [];

                        walkNodes(
                            state.tree.roots,
                            node => {
                                if (
                                    nodeMatches(
                                        node,
                                        normalizedQuery
                                    )
                                ) {
                                    results.push(
                                        clone(
                                            node
                                        )
                                    );
                                }
                            }
                        );

                        return results;
                    },

                getNode:
                    id => {
                        const node =
                            state.tree.byId.get(
                                String(
                                    id
                                )
                            );

                        return node
                            ? clone(
                                node
                            )
                            : null;
                    },

                getSelected:
                    () => {
                        const node =
                            state.selectedId
                                ? state.tree.byId.get(
                                    state.selectedId
                                )
                                : null;

                        return node
                            ? clone(
                                node
                            )
                            : null;
                    },

                setFilter:
                    (
                        query =
                            ""
                    ) => {
                        state.query =
                            String(
                                query
                            );

                        if (
                            searchInput
                        ) {
                            searchInput.value =
                                state.query;
                        }

                        filterTree();
                        renderTree();

                        return {
                            matches:
                                state.matched.size,
                            visible:
                                state.tree.count -
                                state.hidden.size
                        };
                    },

                toJSON:
                    (
                        jsonOptions =
                            {}
                    ) => {
                        function serialize(
                            node
                        ) {
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
                                    clone(
                                        node.metadata
                                    ),
                                children:
                                    node.children.map(
                                        serialize
                                    )
                            };
                        }

                        return JSON.stringify(
                            state.tree.roots.map(
                                serialize
                            ),
                            null,
                            jsonOptions.compact ===
                                true
                                ? 0
                                : 2
                        );
                    },

                status:
                    () => ({
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
                        maxDepth:
                            state.tree.maxDepth,
                        maxNodes:
                            state.tree.maxNodes,
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

                        window.clearTimeout(
                            state.filterTimer
                        );

                        state.abortController.abort();

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

                        this._emit(
                            "instance-destroy",
                            {}
                        );

                        return true;
                    }
            };

            container.treeInstance =
                instance;

            container[
                INSTANCE_SYMBOL
            ] =
                instance;

            container.update =
                instance.refresh;

            container.setData =
                instance.setData;

            container.destroy =
                instance.destroy;

            this.instances.add(
                instance
            );

            this.metrics.renders +=
                1;

            this._emit("render", {
                nodes: normalized.count,
                truncated: normalized.truncated,
                element: container
            });

            return container;
        }

        activeInstance() {
            const root =
                this.context.root;

            const element =
                root?.querySelector?.(
                    ".terminal-renderer-tree"
                ) ||
                document.querySelector(
                    ".terminal-renderer-tree"
                );

            return (
                element?.[
                    INSTANCE_SYMBOL
                ] ||
                element?.
                    treeInstance ||
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
            this.assertActive();

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

            safeDispatch(
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
            new TreeRenderer(
                {}
            );

        const element =
            renderer.render(
                data,
                options
            );

        return element;
    }

    function initialize(
        context =
            {}
    ) {
        const root =
            context.root;

        const existing =
            context.treeRenderer instanceof
                TreeRenderer
                ? context.treeRenderer
                : root?.[
                    RENDERER_SYMBOL
                ];

        if (
            existing instanceof
                TreeRenderer &&
            !existing.destroyed
        ) {
            context.treeRenderer =
                existing;

            context.registerRenderer?.(
                "tree",
                existing
            );

            return existing;
        }

        const renderer =
            new TreeRenderer(
                context
            );

        root[
            RENDERER_SYMBOL
        ] =
            renderer;

        context.registerRenderer?.(
            "tree",
            renderer
        );

        context.registerVisualization?.(
            "tree",
            renderer
        );

        context.treeRenderer =
            renderer;

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
            }) =>
                writeJSON(
                    context.treeRenderer?.
                        status?.() ||
                    null
                )
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
                    context.treeRenderer?.
                        activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active tree renderer is available."
                    );
                }

                const query =
                    args.join(
                        " "
                    );

                return writeJSON({
                    query,
                    ...instance.setFilter(
                        query
                    )
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
                    flags:
                        {}
                },
                context,
                writeJSON
            }) => {
                const instance =
                    context.treeRenderer?.
                        activeInstance?.();

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

                return writeJSON({
                    expanded:
                        instance.expand(
                            args[0],
                            Boolean(
                                parsed.flags.recursive
                            )
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
                    flags:
                        {}
                },
                context,
                writeJSON
            }) => {
                const instance =
                    context.treeRenderer?.
                        activeInstance?.();

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

                return writeJSON({
                    collapsed:
                        instance.collapse(
                            args[0],
                            Boolean(
                                parsed.flags.recursive
                            )
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
                    context.treeRenderer?.
                        activeInstance?.();

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

                return writeJSON(
                    instance.select(
                        args[0]
                    )
                );
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
        normalizeNode,
        normalizeTree,
        walkNodes,
        nodeMatches,
        render,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalTree = api;
    window.SpeciedexTerminalModules = window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[MODULE_NAME] = api;

    document.dispatchEvent(
        new CustomEvent("speciedex:terminal-module-available", {
            detail: {
                name: MODULE_NAME,
                module: api
            }
        })
    );
})(window, document);
