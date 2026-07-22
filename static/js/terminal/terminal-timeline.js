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
    const DEFAULT_LIMIT = 5000;
    const DEFAULT_PAGE_SIZE = 50;
    const DEFAULT_EMPTY_TEXT = "No timeline events.";
    const DEFAULT_DATE_FORMAT = Object.freeze({
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });

    function now() {
        return Date.now();
    }

    function iso(timestamp = now()) {
        return new Date(timestamp).toISOString();
    }

    function isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    function clone(value) {
        if (typeof structuredClone === "function") {
            try {
                return structuredClone(value);
            } catch (error) {
                /* Fall through. */
            }
        }

        if (value === null || value === undefined || typeof value !== "object") {
            return value;
        }

        try {
            return JSON.parse(JSON.stringify(value));
        } catch (error) {
            return value;
        }
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

    function safeDispatch(target, name, detail) {
        try {
            target.dispatchEvent(new CustomEvent(name, { detail }));
        } catch (error) {
            /* Renderer events must not interrupt rendering. */
        }
    }

    function normalizeTimestamp(value, fallback = null) {
        if (value instanceof Date) {
            const timestamp = value.getTime();
            return Number.isFinite(timestamp) ? timestamp : fallback;
        }

        if (typeof value === "number" && Number.isFinite(value)) {
            if (value < 100000000000) {
                return value * 1000;
            }
            return value;
        }

        if (typeof value === "string" && value.trim()) {
            const numeric = Number(value);

            if (Number.isFinite(numeric)) {
                return numeric < 100000000000 ? numeric * 1000 : numeric;
            }

            const parsed = Date.parse(value);
            return Number.isFinite(parsed) ? parsed : fallback;
        }

        return fallback;
    }

    function normalizeText(value, fallback = "") {
        if (value === null || value === undefined) {
            return fallback;
        }

        return String(value).trim();
    }

    function flattenObject(value, prefix = "", output = {}) {
        if (!isObject(value)) {
            return output;
        }

        for (const [key, item] of Object.entries(value)) {
            const path = prefix ? `${prefix}.${key}` : key;

            if (isObject(item)) {
                flattenObject(item, path, output);
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
            "updatedAt",
            "startedAt",
            "finishedAt"
        ].filter(Boolean);

        for (const key of keys) {
            if (isObject(item) && item[key] !== undefined) {
                const timestamp = normalizeTimestamp(item[key], null);

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
                timestamp: normalizeTimestamp(options.defaultTimestamp, now()),
                title: normalizeText(item, `Event ${index + 1}`),
                description: "",
                category: "event",
                status: null,
                icon: null,
                metadata: {},
                raw: item,
                index
            };
        }

        const timestamp = extractTimestamp(item, options);
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
            "updatedAt",
            "startedAt",
            "finishedAt",
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

        const metadata = isObject(item.metadata)
            ? clone(item.metadata)
            : {};

        for (const [key, value] of Object.entries(item)) {
            if (!reserved.has(key)) {
                metadata[key] = value;
            }
        }

        return {
            id: normalizeText(item.id, `event-${index + 1}`),
            timestamp: timestamp ?? normalizeTimestamp(options.defaultTimestamp, now()),
            title: normalizeText(title, `Event ${index + 1}`),
            description: normalizeText(description),
            category: normalizeText(category, "event"),
            status: item.status !== undefined
                ? normalizeText(item.status)
                : null,
            icon: item.icon !== undefined
                ? normalizeText(item.icon)
                : null,
            metadata,
            raw: clone(item),
            index
        };
    }

    function normalizeEvents(data, options = {}) {
        let source = data;

        if (source === null || source === undefined) {
            return [];
        }

        if (isObject(source)) {
            if (Array.isArray(source.events)) {
                source = source.events;
            } else if (Array.isArray(source.timeline)) {
                source = source.timeline;
            } else if (Array.isArray(source.items)) {
                source = source.items;
            } else if (Array.isArray(source.data)) {
                source = source.data;
            } else {
                source = Object.entries(source).map(([key, value]) => {
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
        }

        if (!Array.isArray(source)) {
            source = [source];
        }

        const limit = parseNumber(
            options.maxEvents,
            DEFAULT_LIMIT,
            1,
            100000
        );

        return source
            .slice(0, limit)
            .map((item, index) => normalizeEvent(item, index, options));
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

    function formatTimestamp(timestamp, options = {}) {
        const date = new Date(timestamp);

        if (!Number.isFinite(date.getTime())) {
            return "";
        }

        if (typeof options.dateFormatter === "function") {
            return options.dateFormatter(date, timestamp);
        }

        try {
            return new Intl.DateTimeFormat(
                options.locale || undefined,
                options.dateFormat || DEFAULT_DATE_FORMAT
            ).format(date);
        } catch (error) {
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
            if (absolute >= duration || unit === "second") {
                const value = Math.round(delta / duration);

                if (typeof Intl.RelativeTimeFormat === "function") {
                    return new Intl.RelativeTimeFormat(undefined, {
                        numeric: "auto"
                    }).format(value, unit);
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

        try {
            return new Intl.DateTimeFormat(locale || undefined, {
                year: "numeric",
                month: "2-digit",
                day: "2-digit"
            }).format(date);
        } catch (error) {
            return date.toISOString().slice(0, 10);
        }
    }

    function monthKey(timestamp, locale) {
        const date = new Date(timestamp);

        try {
            return new Intl.DateTimeFormat(locale || undefined, {
                year: "numeric",
                month: "long"
            }).format(date);
        } catch (error) {
            return date.toISOString().slice(0, 7);
        }
    }

    class TimelineRenderer extends EventTarget {
        constructor(context = {}) {
            super();
            this.context = context;
            this.instances = new Set();
        }

        _emit(type, detail = {}) {
            const event = {
                type,
                timestamp: iso(),
                ...detail
            };

            safeDispatch(this, type, event);

            try {
                this.context.events?.emit?.(`timeline:${type}`, event);
            } catch (error) {
                /* Context event bus is optional. */
            }

            return event;
        }

        render(data, options = {}) {
            const allEvents = normalizeEvents(data, options);
            const state = {
                allEvents,
                filteredEvents: [],
                visibleEvents: [],
                query: "",
                categories: new Set(),
                statuses: new Set(),
                start: options.start
                    ? normalizeTimestamp(options.start, null)
                    : null,
                end: options.end
                    ? normalizeTimestamp(options.end, null)
                    : null,
                order: options.order === "asc" ? "asc" : "desc",
                groupBy: options.groupBy || "none",
                page: 1,
                pageSize: parseNumber(
                    options.pageSize,
                    DEFAULT_PAGE_SIZE,
                    1,
                    1000
                ),
                selectedId: null,
                destroyed: false
            };

            const container = createElement(
                "section",
                "terminal-renderer terminal-renderer-timeline"
            );
            container.dataset.renderer = "timeline";
            container.dataset.events = String(allEvents.length);
            container.setAttribute("role", "region");
            container.setAttribute(
                "aria-label",
                options.ariaLabel || options.title || "Terminal timeline"
            );

            const header = createElement("header", "terminal-timeline-header");

            if (options.title) {
                header.appendChild(
                    createElement(
                        "h3",
                        "terminal-timeline-title",
                        options.title
                    )
                );
            }

            if (options.description) {
                header.appendChild(
                    createElement(
                        "p",
                        "terminal-timeline-description",
                        options.description
                    )
                );
            }

            const controls = createElement("div", "terminal-timeline-controls");
            let searchInput = null;
            let categorySelect = null;
            let statusSelect = null;
            let orderButton = null;

            if (options.searchable !== false && allEvents.length) {
                const searchLabel = createElement(
                    "label",
                    "terminal-timeline-search"
                );
                searchLabel.appendChild(
                    createElement(
                        "span",
                        "terminal-timeline-search-label",
                        options.searchLabel || "Filter"
                    )
                );

                searchInput = document.createElement("input");
                searchInput.type = "search";
                searchInput.placeholder =
                    options.searchPlaceholder || "Filter timeline…";
                searchInput.autocomplete = "off";
                searchInput.spellcheck = false;
                searchInput.setAttribute(
                    "aria-label",
                    options.searchLabel || "Filter timeline"
                );

                searchLabel.appendChild(searchInput);
                controls.appendChild(searchLabel);
            }

            const categories = Array.from(
                new Set(allEvents.map((event) => event.category).filter(Boolean))
            ).sort();

            if (options.categoryFilter !== false && categories.length > 1) {
                const label = createElement(
                    "label",
                    "terminal-timeline-category-filter"
                );
                label.appendChild(
                    createElement(
                        "span",
                        "terminal-timeline-filter-label",
                        "Category"
                    )
                );

                categorySelect = document.createElement("select");
                categorySelect.setAttribute("aria-label", "Filter timeline by category");

                const allOption = document.createElement("option");
                allOption.value = "";
                allOption.textContent = "All categories";
                categorySelect.appendChild(allOption);

                for (const category of categories) {
                    const option = document.createElement("option");
                    option.value = category;
                    option.textContent = category;
                    categorySelect.appendChild(option);
                }

                label.appendChild(categorySelect);
                controls.appendChild(label);
            }

            const statuses = Array.from(
                new Set(allEvents.map((event) => event.status).filter(Boolean))
            ).sort();

            if (options.statusFilter !== false && statuses.length > 1) {
                const label = createElement(
                    "label",
                    "terminal-timeline-status-filter"
                );
                label.appendChild(
                    createElement(
                        "span",
                        "terminal-timeline-filter-label",
                        "Status"
                    )
                );

                statusSelect = document.createElement("select");
                statusSelect.setAttribute("aria-label", "Filter timeline by status");

                const allOption = document.createElement("option");
                allOption.value = "";
                allOption.textContent = "All statuses";
                statusSelect.appendChild(allOption);

                for (const status of statuses) {
                    const option = document.createElement("option");
                    option.value = status;
                    option.textContent = status;
                    statusSelect.appendChild(option);
                }

                label.appendChild(statusSelect);
                controls.appendChild(label);
            }

            if (options.sortable !== false && allEvents.length > 1) {
                orderButton = createElement(
                    "button",
                    "terminal-timeline-order",
                    state.order === "asc" ? "Oldest first" : "Newest first"
                );
                orderButton.type = "button";
                orderButton.setAttribute("aria-pressed", state.order === "asc" ? "true" : "false");
                controls.appendChild(orderButton);
            }

            if (controls.childNodes.length) {
                header.appendChild(controls);
            }

            const status = createElement(
                "div",
                "terminal-timeline-status"
            );
            status.setAttribute("aria-live", "polite");
            header.appendChild(status);
            container.appendChild(header);

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
            container.appendChild(viewport);

            const empty = createElement(
                "div",
                "terminal-timeline-empty",
                options.emptyText || DEFAULT_EMPTY_TEXT
            );
            empty.hidden = true;
            container.appendChild(empty);

            const footer = createElement(
                "footer",
                "terminal-timeline-footer"
            );
            const summary = createElement(
                "div",
                "terminal-timeline-summary"
            );
            footer.appendChild(summary);

            let loadMoreButton = null;

            if (options.paginate !== false && allEvents.length > state.pageSize) {
                loadMoreButton = createElement(
                    "button",
                    "terminal-timeline-load-more",
                    options.loadMoreLabel || "Load more"
                );
                loadMoreButton.type = "button";
                footer.appendChild(loadMoreButton);
            }

            container.appendChild(footer);

            function matchesQuery(event) {
                const query = state.query.trim().toLowerCase();

                if (!query) {
                    return true;
                }

                const haystack = [
                    event.title,
                    event.description,
                    event.category,
                    event.status,
                    JSON.stringify(event.metadata)
                ].join(" ").toLowerCase();

                return haystack.includes(query);
            }

            function applyFilters() {
                let events = state.allEvents.filter((event) => {
                    if (!matchesQuery(event)) {
                        return false;
                    }

                    if (
                        state.categories.size &&
                        !state.categories.has(event.category)
                    ) {
                        return false;
                    }

                    if (
                        state.statuses.size &&
                        !state.statuses.has(event.status)
                    ) {
                        return false;
                    }

                    if (
                        state.start !== null &&
                        event.timestamp < state.start
                    ) {
                        return false;
                    }

                    if (
                        state.end !== null &&
                        event.timestamp > state.end
                    ) {
                        return false;
                    }

                    return true;
                });

                events.sort((left, right) => {
                    const delta = left.timestamp - right.timestamp;
                    return state.order === "asc" ? delta : -delta;
                });

                state.filteredEvents = events;
                const count = state.page * state.pageSize;
                state.visibleEvents = events.slice(0, count);
            }

            function createMetaList(metadata) {
                const entries = Object.entries(metadata || {});

                if (!entries.length || options.showMetadata === false) {
                    return null;
                }

                const details = createElement(
                    "details",
                    "terminal-timeline-metadata"
                );
                const summaryElement = createElement(
                    "summary",
                    "terminal-timeline-metadata-summary",
                    options.metadataLabel || "Details"
                );
                const definitionList = createElement(
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

                    if (value instanceof Node) {
                        description.appendChild(value);
                    } else if (isObject(value) || Array.isArray(value)) {
                        const pre = createElement(
                            "pre",
                            "terminal-timeline-metadata-json",
                            JSON.stringify(value, null, 2)
                        );
                        description.appendChild(pre);
                    } else {
                        description.textContent = String(value ?? "");
                    }

                    definitionList.append(term, description);
                }

                details.append(summaryElement, definitionList);
                return details;
            }

            function createEventElement(event, index) {
                const item = createElement(
                    "li",
                    "terminal-timeline-item"
                );
                item.dataset.eventId = event.id;
                item.dataset.category = event.category;
                item.dataset.timestamp = String(event.timestamp);
                item.setAttribute("role", "listitem");

                if (event.status) {
                    item.dataset.status = event.status;
                }

                const marker = createElement(
                    "span",
                    "terminal-timeline-marker"
                );
                marker.setAttribute("aria-hidden", "true");

                if (event.icon) {
                    marker.textContent = event.icon;
                    marker.classList.add("has-icon");
                }

                const content = createElement(
                    "article",
                    "terminal-timeline-content"
                );

                const eventHeader = createElement(
                    "header",
                    "terminal-timeline-event-header"
                );

                const title = createElement(
                    "h4",
                    "terminal-timeline-event-title",
                    event.title
                );
                eventHeader.appendChild(title);

                const time = document.createElement("time");
                time.className = "terminal-timeline-time";
                time.dateTime = new Date(event.timestamp).toISOString();
                time.textContent = formatTimestamp(event.timestamp, options);
                time.title = new Date(event.timestamp).toISOString();
                eventHeader.appendChild(time);

                if (options.relativeTime === true) {
                    const relative = createElement(
                        "span",
                        "terminal-timeline-relative-time",
                        formatRelative(event.timestamp)
                    );
                    eventHeader.appendChild(relative);
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
                    category.dataset.category = event.category;
                    badges.appendChild(category);
                }

                if (event.status) {
                    const eventStatus = createElement(
                        "span",
                        "terminal-timeline-event-status",
                        event.status
                    );
                    eventStatus.dataset.status = event.status;
                    badges.appendChild(eventStatus);
                }

                if (badges.childNodes.length) {
                    eventHeader.appendChild(badges);
                }

                content.appendChild(eventHeader);

                if (event.description) {
                    const description = createElement(
                        "p",
                        "terminal-timeline-event-description",
                        event.description
                    );
                    content.appendChild(description);
                }

                const metadata = createMetaList(event.metadata);
                if (metadata) {
                    content.appendChild(metadata);
                }

                if (typeof options.renderEvent === "function") {
                    try {
                        const custom = options.renderEvent(
                            clone(event),
                            index,
                            item
                        );

                        if (custom instanceof Node) {
                            content.replaceChildren(custom);
                        }
                    } catch (error) {
                        /* Fall back to default event rendering. */
                    }
                }

                if (typeof options.onEventClick === "function") {
                    item.tabIndex = 0;
                    item.classList.add("is-interactive");

                    const activate = () => {
                        state.selectedId = event.id;
                        updateSelection();
                        options.onEventClick(clone(event), item);
                        safeDispatch(container, "terminal-timeline-select", {
                            event: clone(event)
                        });
                    };

                    item.addEventListener("click", activate);
                    item.addEventListener("keydown", (keyboardEvent) => {
                        if (
                            keyboardEvent.key === "Enter" ||
                            keyboardEvent.key === " "
                        ) {
                            keyboardEvent.preventDefault();
                            activate();
                        }
                    });
                }

                item.append(marker, content);
                return item;
            }

            function groupLabel(event) {
                if (state.groupBy === "day") {
                    return dayKey(event.timestamp, options.locale);
                }

                if (state.groupBy === "month") {
                    return monthKey(event.timestamp, options.locale);
                }

                if (state.groupBy === "category") {
                    return event.category || "Uncategorized";
                }

                if (state.groupBy === "status") {
                    return event.status || "Unspecified";
                }

                return null;
            }

            function updateSelection() {
                for (const item of list.querySelectorAll(".terminal-timeline-item")) {
                    const selected = item.dataset.eventId === state.selectedId;
                    item.classList.toggle("is-selected", selected);
                    item.setAttribute("aria-selected", selected ? "true" : "false");
                }
            }

            function renderList() {
                list.replaceChildren();

                const hasEvents = state.visibleEvents.length > 0;
                list.hidden = !hasEvents;
                empty.hidden = hasEvents;

                let currentGroup = null;

                state.visibleEvents.forEach((event, index) => {
                    const label = groupLabel(event);

                    if (label !== null && label !== currentGroup) {
                        currentGroup = label;
                        const group = createElement(
                            "li",
                            "terminal-timeline-group",
                            label
                        );
                        group.dataset.group = label;
                        group.setAttribute("role", "presentation");
                        list.appendChild(group);
                    }

                    list.appendChild(createEventElement(event, index));
                });

                updateSelection();

                const shown = state.visibleEvents.length;
                const total = state.filteredEvents.length;

                summary.textContent =
                    `${shown} of ${total} event${total === 1 ? "" : "s"}` +
                    (total !== state.allEvents.length
                        ? ` filtered from ${state.allEvents.length}`
                        : "");

                status.textContent =
                    `${total} event${total === 1 ? "" : "s"}` +
                    (state.categories.size
                        ? `, ${state.categories.size} categor${state.categories.size === 1 ? "y" : "ies"} selected`
                        : "");

                if (loadMoreButton) {
                    loadMoreButton.hidden = shown >= total;
                    loadMoreButton.disabled = shown >= total;
                }

                container.dataset.filteredEvents = String(total);
                container.dataset.visibleEvents = String(shown);
                container.dataset.order = state.order;
            }

            function refresh() {
                applyFilters();
                renderList();
            }

            if (searchInput) {
                searchInput.addEventListener("input", () => {
                    state.query = searchInput.value;
                    state.page = 1;
                    refresh();

                    safeDispatch(container, "terminal-timeline-filter", {
                        query: state.query,
                        matches: state.filteredEvents.length
                    });
                });
            }

            if (categorySelect) {
                categorySelect.addEventListener("change", () => {
                    state.categories.clear();

                    if (categorySelect.value) {
                        state.categories.add(categorySelect.value);
                    }

                    state.page = 1;
                    refresh();
                });
            }

            if (statusSelect) {
                statusSelect.addEventListener("change", () => {
                    state.statuses.clear();

                    if (statusSelect.value) {
                        state.statuses.add(statusSelect.value);
                    }

                    state.page = 1;
                    refresh();
                });
            }

            if (orderButton) {
                orderButton.addEventListener("click", () => {
                    state.order = state.order === "asc" ? "desc" : "asc";
                    orderButton.textContent =
                        state.order === "asc" ? "Oldest first" : "Newest first";
                    orderButton.setAttribute(
                        "aria-pressed",
                        state.order === "asc" ? "true" : "false"
                    );
                    state.page = 1;
                    refresh();

                    safeDispatch(container, "terminal-timeline-order", {
                        order: state.order
                    });
                });
            }

            if (loadMoreButton) {
                loadMoreButton.addEventListener("click", () => {
                    state.page += 1;
                    refresh();

                    safeDispatch(container, "terminal-timeline-page", {
                        page: state.page,
                        visible: state.visibleEvents.length
                    });
                });
            }

            refresh();

            const instance = {
                element: container,
                state,
                refresh: (nextData = data, nextOptions = {}) => {
                    if (state.destroyed) {
                        return container;
                    }

                    state.allEvents = normalizeEvents(nextData, {
                        ...options,
                        ...nextOptions
                    });
                    state.page = 1;
                    refresh();
                    return container;
                },
                append: (events) => {
                    const normalized = normalizeEvents(events, options);
                    state.allEvents.push(...normalized);
                    state.page = Math.max(
                        state.page,
                        Math.ceil(state.allEvents.length / state.pageSize)
                    );
                    refresh();
                    return normalized.length;
                },
                prepend: (events) => {
                    const normalized = normalizeEvents(events, options);
                    state.allEvents.unshift(...normalized);
                    state.page = Math.max(
                        state.page,
                        Math.ceil(state.allEvents.length / state.pageSize)
                    );
                    refresh();
                    return normalized.length;
                },
                setFilter: (query = "") => {
                    state.query = String(query);

                    if (searchInput) {
                        searchInput.value = state.query;
                    }

                    state.page = 1;
                    refresh();
                    return state.filteredEvents.length;
                },
                setCategory: (category = null) => {
                    state.categories.clear();

                    if (category) {
                        state.categories.add(String(category));
                    }

                    if (categorySelect) {
                        categorySelect.value = category || "";
                    }

                    state.page = 1;
                    refresh();
                    return state.filteredEvents.length;
                },
                setStatus: (eventStatus = null) => {
                    state.statuses.clear();

                    if (eventStatus) {
                        state.statuses.add(String(eventStatus));
                    }

                    if (statusSelect) {
                        statusSelect.value = eventStatus || "";
                    }

                    state.page = 1;
                    refresh();
                    return state.filteredEvents.length;
                },
                setRange: (start = null, end = null) => {
                    state.start = start === null
                        ? null
                        : normalizeTimestamp(start, null);
                    state.end = end === null
                        ? null
                        : normalizeTimestamp(end, null);
                    state.page = 1;
                    refresh();

                    return {
                        start: state.start,
                        end: state.end
                    };
                },
                setOrder: (order = "desc") => {
                    state.order = order === "asc" ? "asc" : "desc";

                    if (orderButton) {
                        orderButton.textContent =
                            state.order === "asc"
                                ? "Oldest first"
                                : "Newest first";
                    }

                    state.page = 1;
                    refresh();
                    return state.order;
                },
                setGroupBy: (groupBy = "none") => {
                    const allowed = new Set([
                        "none",
                        "day",
                        "month",
                        "category",
                        "status"
                    ]);
                    state.groupBy = allowed.has(groupBy)
                        ? groupBy
                        : "none";
                    renderList();
                    return state.groupBy;
                },
                select: (id) => {
                    state.selectedId = id === null ? null : String(id);
                    updateSelection();
                    return state.selectedId;
                },
                getEvents: ({ filtered = false, visible = false } = {}) => {
                    const source = visible
                        ? state.visibleEvents
                        : filtered
                            ? state.filteredEvents
                            : state.allEvents;

                    return source.map(clone);
                },
                toJSON: (jsonOptions = {}) => {
                    const source = jsonOptions.filtered === true
                        ? state.filteredEvents
                        : state.allEvents;

                    return JSON.stringify(
                        source.map((event) => ({
                            id: event.id,
                            timestamp: new Date(event.timestamp).toISOString(),
                            title: event.title,
                            description: event.description,
                            category: event.category,
                            status: event.status,
                            icon: event.icon,
                            metadata: event.metadata
                        })),
                        null,
                        jsonOptions.compact === true ? 0 : 2
                    );
                },
                destroy: () => {
                    if (state.destroyed) {
                        return false;
                    }

                    state.destroyed = true;
                    this.instances.delete(instance);
                    container.remove();
                    this._emit("destroy", {});
                    return true;
                }
            };

            container.timelineInstance = instance;
            this.instances.add(instance);

            this._emit("render", {
                events: allEvents.length,
                element: container
            });

            return container;
        }

        destroy() {
            for (const instance of Array.from(this.instances)) {
                instance.destroy();
            }

            this.instances.clear();
            return true;
        }
    }

    function render(data, options = {}) {
        const renderer = new TimelineRenderer({});
        return renderer.render(data, options);
    }

    function initialize(context = {}) {
        const renderer = new TimelineRenderer(context);
        context.registerRenderer?.("timeline", renderer);
        context.timelineRenderer = renderer;

        safeDispatch(document, "speciedex:terminal-timeline-ready", {
            renderer
        });

        return renderer;
    }

    const commands = [];

    const api = Object.freeze({
        name: MODULE_NAME,
        TimelineRenderer,
        normalizeEvents,
        render,
        initialize,
        mount: initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalTimeline = api;
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
