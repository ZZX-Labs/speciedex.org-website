/*
========================================================================
Speciedex.org
Terminal Timeline Renderer
========================================================================

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME = "Timeline";
    const VERSION = "2.2.0";

    const RENDERER_SYMBOL =
        Symbol.for("speciedex.terminal.timeline.renderer");

    const INSTANCE_SYMBOL =
        Symbol.for("speciedex.terminal.timeline.instance");

    const DEFAULT_LIMIT = 5000;
    const DEFAULT_PAGE_SIZE = 50;
    const DEFAULT_EMPTY_TEXT = "No timeline events.";
    const DEFAULT_FILTER_DEBOUNCE = 120;
    const DEFAULT_METADATA_LIMIT = 128;
    const DEFAULT_METADATA_DEPTH = 8;

    const DEFAULT_DATE_FORMAT = Object.freeze({
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });

    const activeDispatches = new WeakMap();

    function now() {
        return Date.now();
    }

    function iso(timestamp = now()) {
        const date = new Date(timestamp);

        return Number.isFinite(date.getTime())
            ? date.toISOString()
            : new Date().toISOString();
    }

    function isObject(value) {
        return (
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        );
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

    function clone(value, seen = new WeakMap()) {
        if (
            value === null ||
            value === undefined ||
            typeof value !== "object"
        ) {
            return value;
        }

        if (typeof structuredClone === "function") {
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

        const output = {};
        seen.set(value, output);

        for (const [key, item] of Object.entries(value)) {
            if (
                key === "__proto__" ||
                key === "prototype" ||
                key === "constructor"
            ) {
                continue;
            }

            output[key] = clone(item, seen);
        }

        return output;
    }

    function parseBoolean(value, fallback = false) {
        if (typeof value === "boolean") {
            return value;
        }

        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        const normalized =
            String(value).trim().toLowerCase();

        if (
            ["1", "true", "yes", "on", "enabled"].includes(normalized)
        ) {
            return true;
        }

        if (
            ["0", "false", "no", "off", "disabled"].includes(normalized)
        ) {
            return false;
        }

        return fallback;
    }

    function parseNumber(
        value,
        fallback,
        minimum = -Infinity,
        maximum = Infinity
    ) {
        const number = Number(value);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, number));
    }

    function parseInteger(
        value,
        fallback,
        minimum = Number.MIN_SAFE_INTEGER,
        maximum = Number.MAX_SAFE_INTEGER
    ) {
        const number = Number.parseInt(value, 10);

        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(maximum, Math.max(minimum, number));
    }

    function normalizeText(value, fallback = "") {
        if (value === null || value === undefined) {
            return fallback;
        }

        const text = String(value).trim();

        return text || fallback;
    }

    function normalizeTimestamp(value, fallback = null) {
        if (value instanceof Date) {
            const timestamp = value.getTime();

            return Number.isFinite(timestamp)
                ? timestamp
                : fallback;
        }

        if (
            typeof value === "number" &&
            Number.isFinite(value)
        ) {
            return Math.abs(value) < 100000000000
                ? value * 1000
                : value;
        }

        if (
            typeof value === "string" &&
            value.trim()
        ) {
            const trimmed = value.trim();
            const numeric = Number(trimmed);

            if (Number.isFinite(numeric)) {
                return Math.abs(numeric) < 100000000000
                    ? numeric * 1000
                    : numeric;
            }

            const parsed = Date.parse(trimmed);

            return Number.isFinite(parsed)
                ? parsed
                : fallback;
        }

        return fallback;
    }

    function safeDispatch(target, name, detail) {
        if (
            !target ||
            typeof target.dispatchEvent !== "function" ||
            !name
        ) {
            return false;
        }

        let names = activeDispatches.get(target);

        if (!names) {
            names = new Set();
            activeDispatches.set(target, names);
        }

        if (names.has(name)) {
            return false;
        }

        names.add(name);

        try {
            return target.dispatchEvent(
                new CustomEvent(name, { detail })
            );
        } catch (_error) {
            return false;
        } finally {
            names.delete(name);
        }
    }

    function safeStringify(value, spacing = 0) {
        const seen = new WeakSet();

        try {
            return JSON.stringify(
                value,
                (_key, item) => {
                    if (
                        item &&
                        typeof item === "object"
                    ) {
                        if (seen.has(item)) {
                            return "[Circular]";
                        }

                        seen.add(item);
                    }

                    if (typeof item === "bigint") {
                        return String(item);
                    }

                    return item;
                },
                spacing
            );
        } catch (_error) {
            return String(value);
        }
    }

    function flattenObject(
        value,
        prefix = "",
        output = {},
        seen = new WeakSet(),
        depth = 0
    ) {
        if (
            !isObject(value) ||
            depth > DEFAULT_METADATA_DEPTH
        ) {
            return output;
        }

        if (seen.has(value)) {
            return output;
        }

        seen.add(value);

        for (const [key, item] of Object.entries(value)) {
            const path = prefix
                ? `${prefix}.${key}`
                : key;

            if (isObject(item)) {
                flattenObject(
                    item,
                    path,
                    output,
                    seen,
                    depth + 1
                );
            } else {
                output[path] = item;
            }
        }

        return output;
    }

    function extractTimestamp(item, options = {}) {
        const keys = [
            options.timestampKey,
            "timestamp",
            "time",
            "date",
            "datetime",
            "createdAt",
            "created_at",
            "updatedAt",
            "updated_at",
            "startedAt",
            "started_at",
            "finishedAt",
            "finished_at"
        ].filter(Boolean);

        for (const key of keys) {
            if (
                isObject(item) &&
                item[key] !== undefined
            ) {
                const timestamp =
                    normalizeTimestamp(item[key], null);

                if (timestamp !== null) {
                    return timestamp;
                }
            }
        }

        return null;
    }

    function normalizeEvent(item, index, options = {}) {
        if (!isObject(item)) {
            return {
                id: `event-${index + 1}`,
                timestamp:
                    normalizeTimestamp(
                        options.defaultTimestamp,
                        now()
                    ),
                title:
                    normalizeText(
                        item,
                        `Event ${index + 1}`
                    ),
                description: "",
                category: "event",
                status: null,
                icon: null,
                metadata: {},
                raw: clone(item),
                index
            };
        }

        const timestamp =
            extractTimestamp(item, options);

        const title =
            item.title ??
            item.name ??
            item.label ??
            item.event ??
            item.type ??
            `Event ${index + 1}`;

        const description =
            item.description ??
            item.message ??
            item.summary ??
            item.details ??
            "";

        const category =
            item.category ??
            item.group ??
            item.kind ??
            item.type ??
            "event";

        const reserved = new Set([
            "id",
            "timestamp",
            "time",
            "date",
            "datetime",
            "createdAt",
            "created_at",
            "updatedAt",
            "updated_at",
            "startedAt",
            "started_at",
            "finishedAt",
            "finished_at",
            "title",
            "name",
            "label",
            "event",
            "type",
            "description",
            "message",
            "summary",
            "details",
            "category",
            "group",
            "kind",
            "status",
            "icon",
            "metadata"
        ]);

        const metadata =
            isObject(item.metadata)
                ? clone(item.metadata)
                : {};

        for (const [key, value] of Object.entries(item)) {
            if (!reserved.has(key)) {
                metadata[key] = clone(value);
            }
        }

        return {
            id:
                normalizeText(
                    item.id,
                    `event-${index + 1}`
                ),
            timestamp:
                timestamp ??
                normalizeTimestamp(
                    options.defaultTimestamp,
                    now()
                ),
            title:
                normalizeText(
                    title,
                    `Event ${index + 1}`
                ),
            description:
                normalizeText(description),
            category:
                normalizeText(category, "event"),
            status:
                item.status !== undefined &&
                item.status !== null &&
                item.status !== ""
                    ? normalizeText(item.status)
                    : null,
            icon:
                item.icon !== undefined &&
                item.icon !== null &&
                item.icon !== ""
                    ? normalizeText(item.icon)
                    : null,
            metadata,
            raw: clone(item),
            index
        };
    }

    function unwrapEvents(data) {
        if (data === null || data === undefined) {
            return [];
        }

        if (Array.isArray(data)) {
            return data;
        }

        if (data instanceof Set) {
            return Array.from(data.values());
        }

        if (data instanceof Map) {
            return Array.from(data.entries())
                .map(([key, value]) => {
                    if (isObject(value)) {
                        return {
                            id: value.id || key,
                            ...value
                        };
                    }

                    return {
                        id: key,
                        title: key,
                        description: value
                    };
                });
        }

        if (isObject(data)) {
            for (const key of [
                "events",
                "timeline",
                "items",
                "data",
                "records",
                "results",
                "history",
                "entries",
                "updates",
                "releases"
            ]) {
                if (Array.isArray(data[key])) {
                    return data[key];
                }
            }

            return Object.entries(data)
                .map(([key, value]) => {
                    if (isObject(value)) {
                        return {
                            id: value.id || key,
                            ...value
                        };
                    }

                    return {
                        id: key,
                        title: key,
                        description: value
                    };
                });
        }

        return [data];
    }

    function makeUniqueEventIDs(events) {
        const seen = new Map();

        return events.map((event, index) => {
            const base =
                normalizeText(
                    event.id,
                    `event-${index + 1}`
                );

            const count =
                seen.get(base) || 0;

            seen.set(base, count + 1);

            return {
                ...event,
                id:
                    count === 0
                        ? base
                        : `${base}:${count + 1}`,
                index
            };
        });
    }

    function normalizeEvents(data, options = {}) {
        const source = unwrapEvents(data);

        const limit = parseInteger(
            options.maxEvents,
            DEFAULT_LIMIT,
            1,
            100000
        );

        return makeUniqueEventIDs(
            source
                .slice(0, limit)
                .map((item, index) =>
                    normalizeEvent(item, index, options)
                )
        );
    }

    function createElement(tagName, className, text) {
        const element =
            document.createElement(tagName);

        if (className) {
            element.className = className;
        }

        if (text !== undefined) {
            element.textContent = text;
        }

        return element;
    }

    function getDateFormatter(options = {}) {
        try {
            return new Intl.DateTimeFormat(
                options.locale || undefined,
                options.dateFormat ||
                DEFAULT_DATE_FORMAT
            );
        } catch (_error) {
            return null;
        }
    }

    function formatTimestamp(timestamp, options = {}) {
        const date = new Date(timestamp);

        if (!Number.isFinite(date.getTime())) {
            return "";
        }

        if (typeof options.dateFormatter === "function") {
            try {
                return options.dateFormatter(
                    date,
                    timestamp
                );
            } catch (_error) {
                return date.toISOString();
            }
        }

        const formatter = getDateFormatter(options);

        if (!formatter) {
            return date.toISOString();
        }

        try {
            return formatter.format(date);
        } catch (_error) {
            return date.toISOString();
        }
    }

    function formatRelative(timestamp, reference = now()) {
        const delta = timestamp - reference;
        const absolute = Math.abs(delta);

        const units = [
            ["year", 365 * 24 * 60 * 60 * 1000],
            ["month", 30 * 24 * 60 * 60 * 1000],
            ["week", 7 * 24 * 60 * 60 * 1000],
            ["day", 24 * 60 * 60 * 1000],
            ["hour", 60 * 60 * 1000],
            ["minute", 60 * 1000],
            ["second", 1000]
        ];

        for (const [unit, duration] of units) {
            if (
                absolute >= duration ||
                unit === "second"
            ) {
                const value =
                    Math.round(delta / duration);

                if (
                    typeof Intl.RelativeTimeFormat ===
                    "function"
                ) {
                    try {
                        return new Intl.RelativeTimeFormat(
                            undefined,
                            { numeric: "auto" }
                        ).format(value, unit);
                    } catch (_error) {
                        /* Use fallback text. */
                    }
                }

                return value < 0
                    ? `${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? "" : "s"} ago`
                    : `in ${value} ${unit}${value === 1 ? "" : "s"}`;
            }
        }

        return "";
    }

    function dayKey(timestamp, locale) {
        const date = new Date(timestamp);

        if (!Number.isFinite(date.getTime())) {
            return "Unknown date";
        }

        try {
            return new Intl.DateTimeFormat(
                locale || undefined,
                {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit"
                }
            ).format(date);
        } catch (_error) {
            return date.toISOString().slice(0, 10);
        }
    }

    function monthKey(timestamp, locale) {
        const date = new Date(timestamp);

        if (!Number.isFinite(date.getTime())) {
            return "Unknown month";
        }

        try {
            return new Intl.DateTimeFormat(
                locale || undefined,
                {
                    year: "numeric",
                    month: "long"
                }
            ).format(date);
        } catch (_error) {
            return date.toISOString().slice(0, 7);
        }
    }

    class TimelineInstance extends EventTarget {
        constructor(renderer, data, options = {}) {
            super();

            this.renderer = renderer;
            this.options = { ...options };
            this.destroyed = false;

            this.state = {
                allEvents: [],
                filteredEvents: [],
                visibleEvents: [],
                query: "",
                categories: new Set(),
                statuses: new Set(),
                start: null,
                end: null,
                order:
                    options.order === "asc"
                        ? "asc"
                        : "desc",
                groupBy:
                    options.groupBy || "none",
                page: 1,
                pageSize:
                    parseInteger(
                        options.pageSize,
                        DEFAULT_PAGE_SIZE,
                        1,
                        1000
                    ),
                selectedId: null,
                focusedId: null,
                filterTimer: 0,
                renderGeneration: 0
            };

            this.elements = {
                container: null,
                header: null,
                controls: null,
                searchInput: null,
                categorySelect: null,
                statusSelect: null,
                orderButton: null,
                status: null,
                viewport: null,
                list: null,
                empty: null,
                footer: null,
                summary: null,
                loadMoreButton: null
            };

            this._buildShell();
            this.refresh(data, options, {
                initial: true
            });
        }

        assertActive() {
            if (this.destroyed) {
                throw new Error(
                    "Timeline instance has been destroyed."
                );
            }
        }

        _emit(type, detail = {}) {
            if (
                this.destroyed &&
                type !== "destroy"
            ) {
                return null;
            }

            const event = {
                type,
                timestamp: iso(),
                instance: this,
                ...detail
            };

            safeDispatch(this, type, event);
            safeDispatch(
                this.elements.container,
                `terminal-timeline-${type}`,
                event
            );

            this.renderer?._emit?.(type, event);

            return event;
        }

        _buildShell() {
            const container = createElement(
                "section",
                "terminal-renderer terminal-renderer-timeline"
            );

            container.dataset.renderer = "timeline";
            container.setAttribute("role", "region");

            const header = createElement(
                "header",
                "terminal-timeline-header"
            );

            const controls = createElement(
                "div",
                "terminal-timeline-controls"
            );

            const status = createElement(
                "div",
                "terminal-timeline-status"
            );

            status.setAttribute("aria-live", "polite");
            status.setAttribute("aria-atomic", "true");

            const viewport = createElement(
                "div",
                "terminal-timeline-viewport"
            );

            viewport.tabIndex = 0;

            const list = createElement(
                "ol",
                "terminal-timeline-list"
            );

            list.setAttribute("role", "list");
            viewport.appendChild(list);

            const empty = createElement(
                "div",
                "terminal-timeline-empty",
                DEFAULT_EMPTY_TEXT
            );

            empty.hidden = true;
            empty.setAttribute("role", "status");

            const footer = createElement(
                "footer",
                "terminal-timeline-footer"
            );

            const summary = createElement(
                "div",
                "terminal-timeline-summary"
            );

            footer.appendChild(summary);

            header.append(controls, status);
            container.append(
                header,
                viewport,
                empty,
                footer
            );

            this.elements = {
                ...this.elements,
                container,
                header,
                controls,
                status,
                viewport,
                list,
                empty,
                footer,
                summary
            };

            container[INSTANCE_SYMBOL] = this;
            container.timelineInstance = this;
            container.update = (...args) =>
                this.refresh(...args);
            container.setData = (...args) =>
                this.setData(...args);
            container.appendEvents = (...args) =>
                this.append(...args);
            container.prependEvents = (...args) =>
                this.prepend(...args);
            container.destroy = () =>
                this.destroy();
        }

        _syncHeaderText() {
            const {
                header,
                controls,
                status
            } = this.elements;

            for (const element of header.querySelectorAll(
                ":scope > .terminal-timeline-title, :scope > .terminal-timeline-description"
            )) {
                element.remove();
            }

            if (this.options.title) {
                header.insertBefore(
                    createElement(
                        "h3",
                        "terminal-timeline-title",
                        this.options.title
                    ),
                    controls
                );
            }

            if (this.options.description) {
                header.insertBefore(
                    createElement(
                        "p",
                        "terminal-timeline-description",
                        this.options.description
                    ),
                    controls
                );
            }

            this.elements.container.setAttribute(
                "aria-label",
                this.options.ariaLabel ||
                this.options.title ||
                "Terminal timeline"
            );

            status.hidden =
                this.options.status === false;
        }

        _categoryValues() {
            return Array.from(
                new Set(
                    this.state.allEvents
                        .map(event => event.category)
                        .filter(Boolean)
                )
            ).sort((left, right) =>
                String(left).localeCompare(
                    String(right),
                    undefined,
                    { sensitivity: "base" }
                )
            );
        }

        _statusValues() {
            return Array.from(
                new Set(
                    this.state.allEvents
                        .map(event => event.status)
                        .filter(Boolean)
                )
            ).sort((left, right) =>
                String(left).localeCompare(
                    String(right),
                    undefined,
                    { sensitivity: "base" }
                )
            );
        }

        _syncControls() {
            const { controls } = this.elements;
            controls.replaceChildren();

            this.elements.searchInput = null;
            this.elements.categorySelect = null;
            this.elements.statusSelect = null;
            this.elements.orderButton = null;

            if (
                this.options.searchable !== false &&
                this.state.allEvents.length
            ) {
                const label = createElement(
                    "label",
                    "terminal-timeline-search"
                );

                label.appendChild(
                    createElement(
                        "span",
                        "terminal-timeline-search-label",
                        this.options.searchLabel ||
                        "Filter"
                    )
                );

                const input =
                    document.createElement("input");

                input.type = "search";
                input.value = this.state.query;
                input.placeholder =
                    this.options.searchPlaceholder ||
                    "Filter timeline…";
                input.autocomplete = "off";
                input.spellcheck = false;
                input.setAttribute(
                    "aria-label",
                    this.options.searchLabel ||
                    "Filter timeline"
                );

                input.addEventListener(
                    "input",
                    () => {
                        window.clearTimeout(
                            this.state.filterTimer
                        );

                        this.state.filterTimer =
                            window.setTimeout(
                                () => {
                                    this.state.filterTimer = 0;
                                    this.setFilter(
                                        input.value,
                                        { emit: true }
                                    );
                                },
                                parseNumber(
                                    this.options.filterDebounce,
                                    DEFAULT_FILTER_DEBOUNCE,
                                    0,
                                    5000
                                )
                            );
                    }
                );

                label.appendChild(input);
                controls.appendChild(label);
                this.elements.searchInput = input;
            }

            const categories =
                this._categoryValues();

            if (
                this.options.categoryFilter !== false &&
                categories.length > 1
            ) {
                const label = createElement(
                    "label",
                    "terminal-timeline-category-filter"
                );

                label.appendChild(
                    createElement(
                        "span",
                        "terminal-timeline-filter-label",
                        this.options.categoryLabel ||
                        "Category"
                    )
                );

                const select =
                    document.createElement("select");

                select.setAttribute(
                    "aria-label",
                    "Filter timeline by category"
                );

                const all =
                    document.createElement("option");

                all.value = "";
                all.textContent =
                    this.options.allCategoriesLabel ||
                    "All categories";

                select.appendChild(all);

                for (const category of categories) {
                    const option =
                        document.createElement("option");

                    option.value = category;
                    option.textContent = category;
                    select.appendChild(option);
                }

                select.value =
                    this.state.categories.size === 1
                        ? Array.from(
                            this.state.categories
                        )[0]
                        : "";

                select.addEventListener(
                    "change",
                    () => {
                        this.setCategory(
                            select.value || null,
                            { emit: true }
                        );
                    }
                );

                label.appendChild(select);
                controls.appendChild(label);
                this.elements.categorySelect = select;
            }

            const statuses =
                this._statusValues();

            if (
                this.options.statusFilter !== false &&
                statuses.length > 1
            ) {
                const label = createElement(
                    "label",
                    "terminal-timeline-status-filter"
                );

                label.appendChild(
                    createElement(
                        "span",
                        "terminal-timeline-filter-label",
                        this.options.statusLabel ||
                        "Status"
                    )
                );

                const select =
                    document.createElement("select");

                select.setAttribute(
                    "aria-label",
                    "Filter timeline by status"
                );

                const all =
                    document.createElement("option");

                all.value = "";
                all.textContent =
                    this.options.allStatusesLabel ||
                    "All statuses";

                select.appendChild(all);

                for (const eventStatus of statuses) {
                    const option =
                        document.createElement("option");

                    option.value = eventStatus;
                    option.textContent = eventStatus;
                    select.appendChild(option);
                }

                select.value =
                    this.state.statuses.size === 1
                        ? Array.from(
                            this.state.statuses
                        )[0]
                        : "";

                select.addEventListener(
                    "change",
                    () => {
                        this.setStatus(
                            select.value || null,
                            { emit: true }
                        );
                    }
                );

                label.appendChild(select);
                controls.appendChild(label);
                this.elements.statusSelect = select;
            }

            if (
                this.options.sortable !== false &&
                this.state.allEvents.length > 1
            ) {
                const button = createElement(
                    "button",
                    "terminal-timeline-order",
                    this.state.order === "asc"
                        ? "Oldest first"
                        : "Newest first"
                );

                button.type = "button";
                button.setAttribute(
                    "aria-pressed",
                    this.state.order === "asc"
                        ? "true"
                        : "false"
                );

                button.addEventListener(
                    "click",
                    () => {
                        this.setOrder(
                            this.state.order === "asc"
                                ? "desc"
                                : "asc",
                            { emit: true }
                        );
                    }
                );

                controls.appendChild(button);
                this.elements.orderButton = button;
            }

            controls.hidden =
                controls.childNodes.length === 0;
        }

        _matchesQuery(event) {
            const query =
                this.state.query
                    .trim()
                    .toLowerCase();

            if (!query) {
                return true;
            }

            const haystack = [
                event.title,
                event.description,
                event.category,
                event.status,
                safeStringify(event.metadata)
            ]
                .join(" ")
                .toLowerCase();

            return haystack.includes(query);
        }

        _applyFilters() {
            const events =
                this.state.allEvents
                    .filter(event => {
                        if (!this._matchesQuery(event)) {
                            return false;
                        }

                        if (
                            this.state.categories.size &&
                            !this.state.categories.has(
                                event.category
                            )
                        ) {
                            return false;
                        }

                        if (
                            this.state.statuses.size &&
                            !this.state.statuses.has(
                                event.status
                            )
                        ) {
                            return false;
                        }

                        if (
                            this.state.start !== null &&
                            event.timestamp <
                            this.state.start
                        ) {
                            return false;
                        }

                        if (
                            this.state.end !== null &&
                            event.timestamp >
                            this.state.end
                        ) {
                            return false;
                        }

                        return true;
                    })
                    .sort((left, right) => {
                        const delta =
                            left.timestamp -
                            right.timestamp;

                        if (delta !== 0) {
                            return this.state.order === "asc"
                                ? delta
                                : -delta;
                        }

                        return left.index - right.index;
                    });

            this.state.filteredEvents = events;

            const maxPages = Math.max(
                1,
                Math.ceil(
                    events.length /
                    this.state.pageSize
                )
            );

            this.state.page = parseInteger(
                this.state.page,
                1,
                1,
                maxPages
            );

            this.state.visibleEvents =
                events.slice(
                    0,
                    this.state.page *
                    this.state.pageSize
                );
        }

        _createMetaList(metadata) {
            const entries =
                Object.entries(metadata || {})
                    .slice(
                        0,
                        parseInteger(
                            this.options.metadataLimit,
                            DEFAULT_METADATA_LIMIT,
                            0,
                            10000
                        )
                    );

            if (
                !entries.length ||
                this.options.showMetadata === false
            ) {
                return null;
            }

            const details = createElement(
                "details",
                "terminal-timeline-metadata"
            );

            const summary = createElement(
                "summary",
                "terminal-timeline-metadata-summary",
                this.options.metadataLabel ||
                "Details"
            );

            const list = createElement(
                "dl",
                "terminal-timeline-metadata-list"
            );

            for (const [key, value] of entries) {
                const term = createElement(
                    "dt",
                    "terminal-timeline-metadata-key",
                    key
                );

                const description = createElement(
                    "dd",
                    "terminal-timeline-metadata-value"
                );

                if (isNode(value)) {
                    description.appendChild(value);
                } else if (
                    isObject(value) ||
                    Array.isArray(value)
                ) {
                    description.appendChild(
                        createElement(
                            "pre",
                            "terminal-timeline-metadata-json",
                            safeStringify(value, 2)
                        )
                    );
                } else {
                    description.textContent =
                        String(value ?? "");
                }

                list.append(term, description);
            }

            details.append(summary, list);

            return details;
        }

        _groupLabel(event) {
            switch (this.state.groupBy) {
                case "day":
                    return dayKey(
                        event.timestamp,
                        this.options.locale
                    );

                case "month":
                    return monthKey(
                        event.timestamp,
                        this.options.locale
                    );

                case "category":
                    return event.category ||
                        "Uncategorized";

                case "status":
                    return event.status ||
                        "Unspecified";

                default:
                    return null;
            }
        }

        _createEventElement(event, index) {
            const item = createElement(
                "li",
                "terminal-timeline-item"
            );

            item.dataset.eventId = event.id;
            item.dataset.category = event.category;
            item.dataset.timestamp =
                String(event.timestamp);
            item.setAttribute("role", "listitem");

            if (event.status) {
                item.dataset.status = event.status;
            }

            const marker = createElement(
                "span",
                "terminal-timeline-marker"
            );

            marker.setAttribute(
                "aria-hidden",
                "true"
            );

            if (event.icon) {
                marker.textContent = event.icon;
                marker.classList.add("has-icon");
            }

            const content = createElement(
                "article",
                "terminal-timeline-content"
            );

            const header = createElement(
                "header",
                "terminal-timeline-event-header"
            );

            header.appendChild(
                createElement(
                    "h4",
                    "terminal-timeline-event-title",
                    event.title
                )
            );

            const time =
                document.createElement("time");

            time.className =
                "terminal-timeline-time";
            time.dateTime = iso(event.timestamp);
            time.textContent =
                formatTimestamp(
                    event.timestamp,
                    this.options
                );
            time.title = iso(event.timestamp);

            header.appendChild(time);

            if (this.options.relativeTime === true) {
                header.appendChild(
                    createElement(
                        "span",
                        "terminal-timeline-relative-time",
                        formatRelative(
                            event.timestamp
                        )
                    )
                );
            }

            const badges = createElement(
                "div",
                "terminal-timeline-badges"
            );

            if (event.category) {
                const category = createElement(
                    "span",
                    "terminal-timeline-category",
                    event.category
                );

                category.dataset.category =
                    event.category;

                badges.appendChild(category);
            }

            if (event.status) {
                const eventStatus =
                    createElement(
                        "span",
                        "terminal-timeline-event-status",
                        event.status
                    );

                eventStatus.dataset.status =
                    event.status;

                badges.appendChild(eventStatus);
            }

            if (badges.childNodes.length) {
                header.appendChild(badges);
            }

            content.appendChild(header);

            if (event.description) {
                content.appendChild(
                    createElement(
                        "p",
                        "terminal-timeline-event-description",
                        event.description
                    )
                );
            }

            const metadata =
                this._createMetaList(
                    event.metadata
                );

            if (metadata) {
                content.appendChild(metadata);
            }

            if (
                typeof this.options.renderEvent ===
                "function"
            ) {
                try {
                    const custom =
                        this.options.renderEvent(
                            clone(event),
                            index,
                            item
                        );

                    if (isNode(custom)) {
                        content.replaceChildren(custom);
                    }
                } catch (_error) {
                    /* Preserve default event rendering. */
                }
            }

            if (
                typeof this.options.onEventClick ===
                "function"
            ) {
                item.tabIndex = 0;
                item.classList.add("is-interactive");

                const activate = () => {
                    this.select(event.id, {
                        emit: true
                    });

                    this.options.onEventClick(
                        clone(event),
                        item
                    );
                };

                item.addEventListener(
                    "click",
                    activate
                );

                item.addEventListener(
                    "keydown",
                    keyboardEvent => {
                        if (
                            keyboardEvent.key === "Enter" ||
                            keyboardEvent.key === " "
                        ) {
                            keyboardEvent.preventDefault();
                            activate();
                            return;
                        }

                        if (
                            keyboardEvent.key !== "ArrowDown" &&
                            keyboardEvent.key !== "ArrowUp"
                        ) {
                            return;
                        }

                        keyboardEvent.preventDefault();

                        const items = Array.from(
                            this.elements.list
                                .querySelectorAll(
                                    ".terminal-timeline-item"
                                )
                        );

                        const current =
                            items.indexOf(item);

                        const next =
                            keyboardEvent.key === "ArrowDown"
                                ? Math.min(
                                    items.length - 1,
                                    current + 1
                                )
                                : Math.max(
                                    0,
                                    current - 1
                                );

                        items[next]?.focus();
                    }
                );
            }

            item.append(marker, content);

            return item;
        }

        _updateSelection() {
            for (const item of this.elements.list
                .querySelectorAll(
                    ".terminal-timeline-item"
                )) {
                const selected =
                    item.dataset.eventId ===
                    this.state.selectedId;

                item.classList.toggle(
                    "is-selected",
                    selected
                );

                item.setAttribute(
                    "aria-selected",
                    selected
                        ? "true"
                        : "false"
                );
            }
        }

        _renderList() {
            const {
                list,
                empty,
                summary,
                status,
                container
            } = this.elements;

            list.replaceChildren();

            const hasEvents =
                this.state.visibleEvents.length > 0;

            list.hidden = !hasEvents;
            empty.hidden = hasEvents;
            empty.textContent =
                this.options.emptyText ||
                DEFAULT_EMPTY_TEXT;

            let currentGroup = null;

            this.state.visibleEvents
                .forEach((event, index) => {
                    const label =
                        this._groupLabel(event);

                    if (
                        label !== null &&
                        label !== currentGroup
                    ) {
                        currentGroup = label;

                        const group = createElement(
                            "li",
                            "terminal-timeline-group",
                            label
                        );

                        group.dataset.group = label;
                        group.setAttribute(
                            "role",
                            "presentation"
                        );

                        list.appendChild(group);
                    }

                    list.appendChild(
                        this._createEventElement(
                            event,
                            index
                        )
                    );
                });

            this._updateSelection();

            const shown =
                this.state.visibleEvents.length;

            const total =
                this.state.filteredEvents.length;

            summary.textContent =
                `${shown} of ${total} event${total === 1 ? "" : "s"}` +
                (
                    total !== this.state.allEvents.length
                        ? ` filtered from ${this.state.allEvents.length}`
                        : ""
                );

            status.textContent =
                `${total} event${total === 1 ? "" : "s"}` +
                (
                    this.state.categories.size
                        ? `, ${this.state.categories.size} categor${this.state.categories.size === 1 ? "y" : "ies"} selected`
                        : ""
                );

            container.dataset.events =
                String(this.state.allEvents.length);

            container.dataset.filteredEvents =
                String(total);

            container.dataset.visibleEvents =
                String(shown);

            container.dataset.order =
                this.state.order;

            container.dataset.groupBy =
                this.state.groupBy;
        }

        _syncFooter() {
            const {
                footer,
                summary
            } = this.elements;

            this.elements.loadMoreButton?.remove();
            this.elements.loadMoreButton = null;

            const needsMore =
                this.options.paginate !== false &&
                this.state.visibleEvents.length <
                this.state.filteredEvents.length;

            if (needsMore) {
                const button = createElement(
                    "button",
                    "terminal-timeline-load-more",
                    this.options.loadMoreLabel ||
                    "Load more"
                );

                button.type = "button";

                button.addEventListener(
                    "click",
                    () => {
                        this.setPage(
                            this.state.page + 1,
                            { emit: true }
                        );
                    }
                );

                footer.appendChild(button);
                this.elements.loadMoreButton = button;
            }

            summary.hidden =
                this.options.summary === false;

            footer.hidden =
                this.options.summary === false &&
                !needsMore;
        }

        _render() {
            this.assertActive();

            this._applyFilters();
            this._renderList();
            this._syncFooter();

            this.state.renderGeneration += 1;
        }

        refresh(
            data,
            nextOptions = {},
            internal = {}
        ) {
            this.assertActive();

            this.options = {
                ...this.options,
                ...nextOptions
            };

            const preserve =
                nextOptions.keepFilter === true ||
                this.options.preserveState === true;

            const previous = {
                query:
                    this.state.query,
                categories:
                    new Set(this.state.categories),
                statuses:
                    new Set(this.state.statuses),
                start:
                    this.state.start,
                end:
                    this.state.end,
                order:
                    this.state.order,
                groupBy:
                    this.state.groupBy,
                page:
                    this.state.page,
                selectedId:
                    this.state.selectedId
            };

            this.state.allEvents =
                normalizeEvents(
                    data,
                    this.options
                );

            this.state.pageSize =
                parseInteger(
                    this.options.pageSize,
                    DEFAULT_PAGE_SIZE,
                    1,
                    1000
                );

            if (preserve) {
                this.state.query =
                    previous.query;
                this.state.categories =
                    previous.categories;
                this.state.statuses =
                    previous.statuses;
                this.state.start =
                    previous.start;
                this.state.end =
                    previous.end;
                this.state.order =
                    previous.order;
                this.state.groupBy =
                    previous.groupBy;
                this.state.page =
                    previous.page;
                this.state.selectedId =
                    this.state.allEvents.some(
                        event =>
                            event.id ===
                            previous.selectedId
                    )
                        ? previous.selectedId
                        : null;
            } else {
                this.state.query = "";
                this.state.categories.clear();
                this.state.statuses.clear();
                this.state.start =
                    this.options.start !== undefined
                        ? normalizeTimestamp(
                            this.options.start,
                            null
                        )
                        : null;
                this.state.end =
                    this.options.end !== undefined
                        ? normalizeTimestamp(
                            this.options.end,
                            null
                        )
                        : null;
                this.state.order =
                    this.options.order === "asc"
                        ? "asc"
                        : "desc";
                this.state.groupBy =
                    this.options.groupBy ||
                    "none";
                this.state.page = 1;
                this.state.selectedId = null;
            }

            if (
                this.state.start !== null &&
                this.state.end !== null &&
                this.state.start > this.state.end
            ) {
                [
                    this.state.start,
                    this.state.end
                ] = [
                    this.state.end,
                    this.state.start
                ];
            }

            this._syncHeaderText();
            this._syncControls();
            this._render();

            if (internal.initial !== true) {
                this.renderer.metrics.refreshes += 1;

                this._emit("refresh", {
                    events:
                        this.state.allEvents.length
                });
            }

            return this.elements.container;
        }

        setData(data, options = {}) {
            return this.refresh(data, options);
        }

        append(events, options = {}) {
            this.assertActive();

            const normalized =
                normalizeEvents(
                    events,
                    {
                        ...this.options,
                        ...options
                    }
                );

            const limit =
                parseInteger(
                    this.options.maxEvents,
                    DEFAULT_LIMIT,
                    1,
                    100000
                );

            this.state.allEvents =
                makeUniqueEventIDs([
                    ...this.state.allEvents,
                    ...normalized
                ]).slice(-limit);

            this._syncControls();
            this._render();

            this.renderer.metrics.appends +=
                normalized.length;

            this._emit("append", {
                count: normalized.length
            });

            return normalized.length;
        }

        prepend(events, options = {}) {
            this.assertActive();

            const normalized =
                normalizeEvents(
                    events,
                    {
                        ...this.options,
                        ...options
                    }
                );

            const limit =
                parseInteger(
                    this.options.maxEvents,
                    DEFAULT_LIMIT,
                    1,
                    100000
                );

            this.state.allEvents =
                makeUniqueEventIDs([
                    ...normalized,
                    ...this.state.allEvents
                ]).slice(0, limit);

            this._syncControls();
            this._render();

            this.renderer.metrics.prepends +=
                normalized.length;

            this._emit("prepend", {
                count: normalized.length
            });

            return normalized.length;
        }

        setFilter(query = "", options = {}) {
            this.assertActive();

            this.state.query = String(query);
            this.state.page = 1;

            if (
                this.elements.searchInput &&
                this.elements.searchInput.value !==
                    this.state.query
            ) {
                this.elements.searchInput.value =
                    this.state.query;
            }

            this._render();

            this.renderer.metrics.filters += 1;

            if (options.emit !== false) {
                this._emit("filter", {
                    query: this.state.query,
                    matches:
                        this.state.filteredEvents.length
                });
            }

            return this.state.filteredEvents.length;
        }

        setCategory(category = null, options = {}) {
            this.assertActive();

            this.state.categories.clear();

            if (category) {
                this.state.categories.add(
                    String(category)
                );
            }

            this.state.page = 1;

            if (this.elements.categorySelect) {
                this.elements.categorySelect.value =
                    category || "";
            }

            this._render();

            if (options.emit !== false) {
                this._emit("category", {
                    category:
                        category || null,
                    matches:
                        this.state.filteredEvents.length
                });
            }

            return this.state.filteredEvents.length;
        }

        setStatus(eventStatus = null, options = {}) {
            this.assertActive();

            this.state.statuses.clear();

            if (eventStatus) {
                this.state.statuses.add(
                    String(eventStatus)
                );
            }

            this.state.page = 1;

            if (this.elements.statusSelect) {
                this.elements.statusSelect.value =
                    eventStatus || "";
            }

            this._render();

            if (options.emit !== false) {
                this._emit("status-filter", {
                    status:
                        eventStatus || null,
                    matches:
                        this.state.filteredEvents.length
                });
            }

            return this.state.filteredEvents.length;
        }

        setRange(start = null, end = null, options = {}) {
            this.assertActive();

            this.state.start =
                start === null || start === ""
                    ? null
                    : normalizeTimestamp(
                        start,
                        null
                    );

            this.state.end =
                end === null || end === ""
                    ? null
                    : normalizeTimestamp(
                        end,
                        null
                    );

            if (
                start !== null &&
                start !== "" &&
                this.state.start === null
            ) {
                throw new Error(
                    `Invalid timeline start value: ${start}`
                );
            }

            if (
                end !== null &&
                end !== "" &&
                this.state.end === null
            ) {
                throw new Error(
                    `Invalid timeline end value: ${end}`
                );
            }

            if (
                this.state.start !== null &&
                this.state.end !== null &&
                this.state.start > this.state.end
            ) {
                [
                    this.state.start,
                    this.state.end
                ] = [
                    this.state.end,
                    this.state.start
                ];
            }

            this.state.page = 1;
            this._render();

            const result = {
                start: this.state.start,
                end: this.state.end
            };

            if (options.emit !== false) {
                this._emit("range", result);
            }

            return result;
        }

        setOrder(order = "desc", options = {}) {
            this.assertActive();

            this.state.order =
                order === "asc"
                    ? "asc"
                    : "desc";

            this.state.page = 1;

            if (this.elements.orderButton) {
                this.elements.orderButton.textContent =
                    this.state.order === "asc"
                        ? "Oldest first"
                        : "Newest first";

                this.elements.orderButton.setAttribute(
                    "aria-pressed",
                    this.state.order === "asc"
                        ? "true"
                        : "false"
                );
            }

            this._render();
            this.renderer.metrics.orders += 1;

            if (options.emit !== false) {
                this._emit("order", {
                    order: this.state.order
                });
            }

            return this.state.order;
        }

        setGroupBy(groupBy = "none", options = {}) {
            this.assertActive();

            const allowed = new Set([
                "none",
                "day",
                "month",
                "category",
                "status"
            ]);

            this.state.groupBy =
                allowed.has(groupBy)
                    ? groupBy
                    : "none";

            this._render();

            if (options.emit !== false) {
                this._emit("group", {
                    groupBy:
                        this.state.groupBy
                });
            }

            return this.state.groupBy;
        }

        setPage(page, options = {}) {
            this.assertActive();

            const pages = Math.max(
                1,
                Math.ceil(
                    this.state.filteredEvents.length /
                    this.state.pageSize
                )
            );

            this.state.page =
                parseInteger(
                    page,
                    this.state.page,
                    1,
                    pages
                );

            this._render();

            if (options.emit !== false) {
                this._emit("page", {
                    page:
                        this.state.page,
                    visible:
                        this.state.visibleEvents.length
                });
            }

            return this.state.page;
        }

        select(id, options = {}) {
            this.assertActive();

            const normalized =
                id === null || id === undefined
                    ? null
                    : String(id);

            if (
                normalized !== null &&
                !this.state.allEvents.some(
                    event =>
                        event.id === normalized
                )
            ) {
                return null;
            }

            this.state.selectedId = normalized;
            this._updateSelection();

            if (
                normalized !== null &&
                options.emit !== false
            ) {
                const event =
                    this.state.allEvents.find(
                        item =>
                            item.id === normalized
                    );

                this.renderer.metrics.selections += 1;

                this._emit("select", {
                    event: clone(event)
                });
            }

            return this.state.selectedId;
        }

        getEvents({
            filtered = false,
            visible = false
        } = {}) {
            this.assertActive();

            const source =
                visible
                    ? this.state.visibleEvents
                    : filtered
                        ? this.state.filteredEvents
                        : this.state.allEvents;

            return source.map(clone);
        }

        toJSON(options = {}) {
            this.assertActive();

            const source =
                options.visible === true
                    ? this.state.visibleEvents
                    : options.filtered === true
                        ? this.state.filteredEvents
                        : this.state.allEvents;

            return safeStringify(
                source.map(event => ({
                    id: event.id,
                    timestamp: iso(event.timestamp),
                    title: event.title,
                    description:
                        event.description,
                    category:
                        event.category,
                    status: event.status,
                    icon: event.icon,
                    metadata:
                        event.metadata
                })),
                options.compact === true
                    ? 0
                    : 2
            );
        }

        status() {
            return {
                version: VERSION,
                events:
                    this.state.allEvents.length,
                filteredEvents:
                    this.state.filteredEvents.length,
                visibleEvents:
                    this.state.visibleEvents.length,
                page:
                    this.state.page,
                pageSize:
                    this.state.pageSize,
                query:
                    this.state.query,
                categories:
                    [...this.state.categories],
                statuses:
                    [...this.state.statuses],
                start:
                    this.state.start,
                end:
                    this.state.end,
                order:
                    this.state.order,
                groupBy:
                    this.state.groupBy,
                selectedId:
                    this.state.selectedId,
                renderGeneration:
                    this.state.renderGeneration,
                connected:
                    this.elements.container.isConnected,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            window.clearTimeout(
                this.state.filterTimer
            );

            this.destroyed = true;
            this.renderer?.instances?.delete(this);

            if (
                this.elements.container[
                    INSTANCE_SYMBOL
                ] === this
            ) {
                delete this.elements.container[
                    INSTANCE_SYMBOL
                ];
            }

            delete this.elements.container.timelineInstance;
            delete this.elements.container.update;
            delete this.elements.container.setData;
            delete this.elements.container.appendEvents;
            delete this.elements.container.prependEvents;
            delete this.elements.container.destroy;

            this.elements.container.remove();

            this.renderer.metrics.destroyedInstances += 1;

            safeDispatch(
                this,
                "destroy",
                {
                    version: VERSION,
                    instance: this
                }
            );

            return true;
        }
    }

    class TimelineRenderer extends EventTarget {
        constructor(context = {}) {
            super();

            this.context =
                isObject(context)
                    ? context
                    : {};

            this.instances = new Set();
            this.destroyed = false;

            this.metrics = {
                renders: 0,
                refreshes: 0,
                appends: 0,
                prepends: 0,
                filters: 0,
                orders: 0,
                selections: 0,
                destroyedInstances: 0
            };
        }

        assertActive() {
            if (this.destroyed) {
                throw new Error(
                    "Timeline renderer has been destroyed."
                );
            }
        }

        _emit(type, detail = {}) {
            if (
                this.destroyed &&
                type !== "destroy"
            ) {
                return null;
            }

            const event = {
                type,
                timestamp: iso(),
                renderer: this,
                ...detail
            };

            safeDispatch(this, type, event);

            try {
                this.context.events?.emit?.(
                    `timeline:${type}`,
                    event
                );
            } catch (_error) {
                /* Context event bus is optional. */
            }

            return event;
        }

        render(data, options = {}) {
            this.assertActive();

            const instance =
                new TimelineInstance(
                    this,
                    data,
                    options
                );

            this.instances.add(instance);
            this.metrics.renders += 1;

            this._emit("render", {
                events:
                    instance.state.allEvents.length,
                element:
                    instance.elements.container,
                instance
            });

            return instance.elements.container;
        }

        mount(target, data, options = {}) {
            this.assertActive();

            const element =
                this.render(data, options);

            if (isElement(target)) {
                for (const old of target.querySelectorAll(
                    ":scope > .terminal-renderer-timeline"
                )) {
                    old[INSTANCE_SYMBOL]?.destroy?.();
                }

                target.replaceChildren(element);
            }

            return element;
        }

        activeInstance() {
            const root =
                this.context.root;

            const element =
                root?.querySelector?.(
                    ".terminal-renderer-timeline"
                ) ||
                document.querySelector(
                    ".terminal-renderer-timeline"
                );

            const direct =
                element?.[INSTANCE_SYMBOL] ||
                element?.timelineInstance;

            if (
                direct &&
                !direct.destroyed
            ) {
                return direct;
            }

            const instances =
                Array.from(this.instances)
                    .filter(instance =>
                        !instance.destroyed
                    );

            return instances.length
                ? instances[instances.length - 1]
                : null;
        }

        status() {
            const active =
                this.activeInstance();

            return {
                version: VERSION,
                instances:
                    this.instances.size,
                metrics: {
                    ...this.metrics
                },
                active:
                    active?.status?.() ||
                    null,
                destroyed:
                    this.destroyed
            };
        }

        destroy() {
            if (this.destroyed) {
                return false;
            }

            for (const instance of Array.from(
                this.instances
            )) {
                instance.destroy();
            }

            this.instances.clear();

            const root =
                this.context.root;

            if (
                root &&
                root[RENDERER_SYMBOL] === this
            ) {
                delete root[RENDERER_SYMBOL];
            }

            this.destroyed = true;

            safeDispatch(
                this,
                "destroy",
                {
                    version: VERSION,
                    renderer: this
                }
            );

            return true;
        }
    }

    function render(data, options = {}) {
        const renderer =
            new TimelineRenderer({});

        const element =
            renderer.render(data, options);

        const instance =
            element[INSTANCE_SYMBOL];

        const originalDestroy =
            instance.destroy.bind(instance);

        instance.destroy = () => {
            const result = originalDestroy();
            renderer.destroy();
            return result;
        };

        element.destroy =
            instance.destroy;

        return element;
    }

    function initialize(context = {}) {
        const safeContext =
            isObject(context)
                ? context
                : {};

        const root =
            isElement(safeContext.root)
                ? safeContext.root
                : null;

        const existing =
            safeContext.timelineRenderer instanceof
                TimelineRenderer
                ? safeContext.timelineRenderer
                : root?.[RENDERER_SYMBOL];

        if (
            existing instanceof TimelineRenderer &&
            !existing.destroyed
        ) {
            safeContext.timelineRenderer = existing;

            safeContext.registerRenderer?.(
                "timeline",
                existing
            );

            safeContext.registerVisualization?.(
                "timeline",
                existing
            );

            return existing;
        }

        const renderer =
            new TimelineRenderer(safeContext);

        if (root) {
            root[RENDERER_SYMBOL] =
                renderer;
        }

        safeContext.registerRenderer?.(
            "timeline",
            renderer
        );

        safeContext.registerVisualization?.(
            "timeline",
            renderer
        );

        safeContext.timelineRenderer =
            renderer;

        safeDispatch(
            document,
            "speciedex:terminal-timeline-ready",
            {
                renderer,
                version: VERSION
            }
        );

        return renderer;
    }

    function resolveCommandContext(payload = {}) {
        return (
            payload.context ||
            payload.terminal?.context ||
            payload.app?.context ||
            payload
        );
    }

    function writeJSONResult(payload, value) {
        if (typeof payload.writeJSON === "function") {
            return payload.writeJSON(value);
        }

        if (typeof payload.write === "function") {
            return payload.write(
                safeStringify(value, 2)
            );
        }

        return value;
    }

    const commands = [
        {
            name: "timeline-status",
            category: "visualization",
            description:
                "Display timeline-renderer diagnostics.",
            usage: "timeline-status",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                return writeJSONResult(
                    payload,
                    context.timelineRenderer
                        ?.status?.() ||
                    null
                );
            }
        },

        {
            name: "timeline-filter",
            category: "visualization",
            description:
                "Filter the active timeline.",
            usage:
                "timeline-filter [query]",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const instance =
                    context.timelineRenderer
                        ?.activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active timeline renderer is available."
                    );
                }

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                const query =
                    args.join(" ");

                return writeJSONResult(
                    payload,
                    {
                        query,
                        matches:
                            instance.setFilter(query)
                    }
                );
            }
        },

        {
            name: "timeline-order",
            category: "visualization",
            description:
                "Set active timeline order.",
            usage:
                "timeline-order <asc|desc>",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const instance =
                    context.timelineRenderer
                        ?.activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active timeline renderer is available."
                    );
                }

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                return writeJSONResult(
                    payload,
                    {
                        order:
                            instance.setOrder(
                                args[0] || "desc"
                            )
                    }
                );
            }
        },

        {
            name: "timeline-group",
            category: "visualization",
            description:
                "Group the active timeline.",
            usage:
                "timeline-group <none|day|month|category|status>",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const instance =
                    context.timelineRenderer
                        ?.activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active timeline renderer is available."
                    );
                }

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                return writeJSONResult(
                    payload,
                    {
                        groupBy:
                            instance.setGroupBy(
                                args[0] || "none"
                            )
                    }
                );
            }
        },

        {
            name: "timeline-range",
            category: "visualization",
            description:
                "Set the active timeline date range.",
            usage:
                "timeline-range [start] [end]",

            handler: payload => {
                const context =
                    resolveCommandContext(payload);

                const instance =
                    context.timelineRenderer
                        ?.activeInstance?.();

                if (!instance) {
                    throw new Error(
                        "No active timeline renderer is available."
                    );
                }

                const args =
                    Array.isArray(payload.args)
                        ? payload.args
                        : [];

                return writeJSONResult(
                    payload,
                    instance.setRange(
                        args[0] || null,
                        args[1] || null
                    )
                );
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        version: VERSION,
        RENDERER_SYMBOL,
        INSTANCE_SYMBOL,
        TimelineRenderer,
        TimelineInstance,
        normalizeTimestamp,
        normalizeEvent,
        normalizeEvents,
        formatTimestamp,
        formatRelative,
        render,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalTimeline = api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};

    window.SpeciedexTerminalModules[MODULE_NAME] =
        api;

    safeDispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name: MODULE_NAME,
            module: api
        }
    );
})(window, document);
