/*
========================================================================
Speciedex.org
Terminal Router
========================================================================

Command, view, and internal navigation router for SpeciedexTerminal.

Provides:

    • named routes
    • parameterized paths
    • query-string parsing
    • route guards
    • middleware
    • redirects
    • internal view mounting
    • browser URL synchronization
    • hash and history modes
    • navigation history
    • back and forward navigation
    • deep-link generation
    • route inspection
    • lifecycle events
    • terminal commands
    • clean teardown

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Router";

    const VERSION =
        "2.0.0";

    const DEFAULT_OPTIONS =
        Object.freeze({
            mode:
                "memory",

            basePath:
                "/",

            syncBrowser:
                false,

            interceptLinks:
                false,

            restore:
                false,

            maximumHistory:
                250,

            defaultRoute:
                "home",

            notFoundRoute:
                "not-found",

            preserveScroll:
                false,

            replaceInitial:
                true
        });

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function normalizeText(
        value
    ) {
        return String(
            value ?? ""
        ).trim();
    }

    function parseBoolean(
        value,
        fallback = false
    ) {
        if (
            value === undefined ||
            value === null ||
            value === ""
        ) {
            return fallback;
        }

        return ![
            "false",
            "0",
            "no",
            "off"
        ].includes(
            String(value)
                .trim()
                .toLowerCase()
        );
    }

    function clampInteger(
        value,
        fallback,
        minimum,
        maximum
    ) {
        const parsed =
            Number.parseInt(
                value,
                10
            );

        if (!Number.isFinite(parsed)) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(
                minimum,
                parsed
            )
        );
    }

    function normalizeMode(
        value
    ) {
        const mode =
            normalizeText(
                value
            ).toLowerCase();

        return [
            "memory",
            "hash",
            "history"
        ].includes(
            mode
        )
            ? mode
            : "memory";
    }

    function normalizePath(
        value
    ) {
        let path =
            normalizeText(
                value
            );

        if (!path) {
            return "/";
        }

        if (
            path.startsWith(
                "#"
            )
        ) {
            path =
                path.slice(
                    1
                );
        }

        if (
            !path.startsWith(
                "/"
            )
        ) {
            path =
                `/${path}`;
        }

        path =
            path.replace(
                /\/{2,}/g,
                "/"
            );

        if (
            path.length >
                1 &&
            path.endsWith(
                "/"
            )
        ) {
            path =
                path.slice(
                    0,
                    -1
                );
        }

        return path ||
            "/";
    }

    function normalizeBasePath(
        value
    ) {
        const path =
            normalizePath(
                value
            );

        return path ===
            "/"
            ? "/"
            : `${path}/`;
    }

    function parseQuery(
        value
    ) {
        const text =
            normalizeText(
                value
            );

        const query =
            text.startsWith(
                "?"
            )
                ? text.slice(
                    1
                )
                : text;

        const params =
            new URLSearchParams(
                query
            );

        const output =
            {};

        for (
            const [
                key,
                item
            ] of params
        ) {
            if (
                Object.prototype.hasOwnProperty.call(
                    output,
                    key
                )
            ) {
                output[
                    key
                ] =
                    Array.isArray(
                        output[
                            key
                        ]
                    )
                        ? [
                            ...output[
                                key
                            ],
                            item
                        ]
                        : [
                            output[
                                key
                            ],
                            item
                        ];
            } else {
                output[
                    key
                ] =
                    item;
            }
        }

        return output;
    }

    function stringifyQuery(
        query
    ) {
        if (
            !query ||
            typeof query !==
            "object"
        ) {
            return "";
        }

        const params =
            new URLSearchParams();

        for (
            const [
                key,
                value
            ] of Object.entries(
                query
            )
        ) {
            if (
                value === undefined ||
                value === null ||
                value === ""
            ) {
                continue;
            }

            if (
                Array.isArray(
                    value
                )
            ) {
                for (const item of value) {
                    params.append(
                        key,
                        String(item)
                    );
                }

                continue;
            }

            params.set(
                key,
                String(value)
            );
        }

        const text =
            params.toString();

        return text
            ? `?${text}`
            : "";
    }

    function splitLocation(
        value
    ) {
        const text =
            normalizeText(
                value
            ) ||
            "/";

        const hashIndex =
            text.indexOf(
                "#"
            );

        const hash =
            hashIndex >=
                0
                ? text.slice(
                    hashIndex +
                    1
                )
                : "";

        const withoutHash =
            hashIndex >=
                0
                ? text.slice(
                    0,
                    hashIndex
                )
                : text;

        const queryIndex =
            withoutHash.indexOf(
                "?"
            );

        const path =
            normalizePath(
                queryIndex >=
                    0
                    ? withoutHash.slice(
                        0,
                        queryIndex
                    )
                    : withoutHash
            );

        const queryText =
            queryIndex >=
                0
                ? withoutHash.slice(
                    queryIndex +
                    1
                )
                : "";

        return {
            path,
            query:
                parseQuery(
                    queryText
                ),
            queryString:
                queryText
                    ? `?${queryText}`
                    : "",
            hash
        };
    }

    function encodePathSegment(
        value
    ) {
        return encodeURIComponent(
            String(
                value ?? ""
            )
        );
    }

    function escapeRegExp(
        value
    ) {
        return String(value)
            .replace(
                /[.*+?^${}()|[\]\\]/g,
                "\\$&"
            );
    }

    function compilePath(
        pattern
    ) {
        const normalized =
            normalizePath(
                pattern
            );

        const keys =
            [];

        if (
            normalized ===
            "/"
        ) {
            return {
                pattern:
                    normalized,
                keys,
                regex:
                    /^\/$/
            };
        }

        const segments =
            normalized
                .split(
                    "/"
                )
                .filter(Boolean);

        const source =
            segments.map(
                segment => {
                    if (
                        segment ===
                        "*"
                    ) {
                        keys.push(
                            "wildcard"
                        );

                        return "(.*)";
                    }

                    if (
                        segment.startsWith(
                            ":"
                        )
                    ) {
                        const optional =
                            segment.endsWith(
                                "?"
                            );

                        const name =
                            segment
                                .slice(
                                    1,
                                    optional
                                        ? -1
                                        : undefined
                                );

                        keys.push(
                            name
                        );

                        return optional
                            ? "([^/]*)"
                            : "([^/]+)";
                    }

                    return escapeRegExp(
                        segment
                    );
                }
            )
                .join(
                    "/"
                );

        return {
            pattern:
                normalized,
            keys,
            regex:
                new RegExp(
                    `^/${source}/?$`
                )
        };
    }

    function buildPath(
        pattern,
        params = {}
    ) {
        const normalized =
            normalizePath(
                pattern
            );

        if (
            normalized ===
            "/"
        ) {
            return "/";
        }

        const segments =
            normalized
                .split(
                    "/"
                )
                .filter(Boolean);

        const output =
            [];

        for (const segment of segments) {
            if (
                segment ===
                "*"
            ) {
                const value =
                    params.wildcard ??
                    "";

                if (value) {
                    output.push(
                        String(value)
                            .split("/")
                            .map(
                                encodePathSegment
                            )
                            .join("/")
                    );
                }

                continue;
            }

            if (
                segment.startsWith(
                    ":"
                )
            ) {
                const optional =
                    segment.endsWith(
                        "?"
                    );

                const name =
                    segment.slice(
                        1,
                        optional
                            ? -1
                            : undefined
                    );

                const value =
                    params[
                        name
                    ];

                if (
                    value === undefined ||
                    value === null ||
                    value === ""
                ) {
                    if (optional) {
                        continue;
                    }

                    throw new Error(
                        `Missing route parameter: ${name}`
                    );
                }

                output.push(
                    encodePathSegment(
                        value
                    )
                );

                continue;
            }

            output.push(
                segment
            );
        }

        return normalizePath(
            output.join(
                "/"
            )
        );
    }

    function decodeParams(
        compiled,
        match
    ) {
        const params =
            {};

        compiled.keys.forEach(
            (
                key,
                index
            ) => {
                const value =
                    match[
                        index +
                        1
                    ];

                params[
                    key
                ] =
                    value ===
                    undefined
                        ? undefined
                        : decodeURIComponent(
                            value
                        );
            }
        );

        return params;
    }

    function safeClone(
        value
    ) {
        if (
            value === undefined
        ) {
            return undefined;
        }

        try {
            return structuredClone(
                value
            );
        } catch (error) {
            try {
                return JSON.parse(
                    JSON.stringify(
                        value
                    )
                );
            } catch (nestedError) {
                return value;
            }
        }
    }

    function makeNavigationID() {
        if (
            window.crypto &&
            typeof window.crypto.randomUUID ===
            "function"
        ) {
            return window.crypto.randomUUID();
        }

        return (
            `route:${Date.now()}:` +
            Math.random()
                .toString(16)
                .slice(2)
        );
    }

    /*
    ==========================================================================
    Router
    ==========================================================================
    */

    class TerminalRouter
        extends EventTarget {
        constructor(
            context,
            options = {}
        ) {
            super();

            this.context =
                context;

            this.options = {
                ...DEFAULT_OPTIONS,
                ...options,

                mode:
                    normalizeMode(
                        options.mode ||
                        DEFAULT_OPTIONS.mode
                    ),

                basePath:
                    normalizeBasePath(
                        options.basePath ||
                        DEFAULT_OPTIONS.basePath
                    ),

                maximumHistory:
                    clampInteger(
                        options.maximumHistory,
                        DEFAULT_OPTIONS.maximumHistory,
                        10,
                        5000
                    )
            };

            this.routes =
                new Map();

            this.routeOrder =
                [];

            this.middleware =
                [];

            this.guards =
                [];

            this.history =
                [];

            this.historyIndex =
                -1;

            this.current =
                null;

            this.started =
                false;

            this.destroyed =
                false;

            this.viewHost =
                this.resolveViewHost();

            this.boundPopState =
                event =>
                    this.handleBrowserNavigation(
                        event
                    );

            this.boundHashChange =
                event =>
                    this.handleBrowserNavigation(
                        event
                    );

            this.boundClick =
                event =>
                    this.handleLinkClick(
                        event
                    );

            this.registerBuiltins();

            if (
                this.options.restore
            ) {
                this.restoreFromBrowser();
            }
        }

        /*
        ======================================================================
        Route Registration
        ======================================================================
        */

        register(
            definition
        ) {
            if (
                !definition ||
                typeof definition !==
                "object"
            ) {
                throw new TypeError(
                    "Route definition must be an object."
                );
            }

            const name =
                normalizeText(
                    definition.name
                )
                    .toLowerCase();

            if (
                !/^[a-z0-9][a-z0-9:_-]*$/.test(
                    name
                )
            ) {
                throw new Error(
                    `Invalid route name: ${name || "(empty)"}`
                );
            }

            const path =
                normalizePath(
                    definition.path ||
                    `/${name}`
                );

            const compiled =
                compilePath(
                    path
                );

            const route = {
                name,
                path,
                compiled,

                title:
                    normalizeText(
                        definition.title ||
                        name
                    ),

                description:
                    normalizeText(
                        definition.description ||
                        ""
                    ),

                category:
                    normalizeText(
                        definition.category ||
                        "internal"
                    ),

                handler:
                    typeof definition.handler ===
                    "function"
                        ? definition.handler
                        : null,

                view:
                    typeof definition.view ===
                    "function"
                        ? definition.view
                        : definition.view ||
                        null,

                redirect:
                    definition.redirect ||
                    null,

                guard:
                    typeof definition.guard ===
                    "function"
                        ? definition.guard
                        : null,

                middleware:
                    Array.isArray(
                        definition.middleware
                    )
                        ? definition.middleware.filter(
                            item =>
                                typeof item ===
                                "function"
                        )
                        : [],

                metadata:
                    safeClone(
                        definition.metadata ||
                        {}
                    ),

                hidden:
                    Boolean(
                        definition.hidden
                    )
            };

            if (
                this.routes.has(
                    name
                )
            ) {
                const index =
                    this.routeOrder.indexOf(
                        name
                    );

                if (
                    index >=
                    0
                ) {
                    this.routeOrder.splice(
                        index,
                        1
                    );
                }
            }

            this.routes.set(
                name,
                route
            );

            this.routeOrder.push(
                name
            );

            this.emit(
                "route-registered",
                {
                    route:
                        this.serializeRoute(
                            route
                        )
                }
            );

            return route;
        }

        unregister(
            name
        ) {
            const normalized =
                normalizeText(
                    name
                ).toLowerCase();

            if (
                !this.routes.has(
                    normalized
                )
            ) {
                return false;
            }

            this.routes.delete(
                normalized
            );

            const index =
                this.routeOrder.indexOf(
                    normalized
                );

            if (
                index >=
                0
            ) {
                this.routeOrder.splice(
                    index,
                    1
                );
            }

            this.emit(
                "route-unregistered",
                {
                    name:
                        normalized
                }
            );

            return true;
        }

        getRoute(
            name
        ) {
            return (
                this.routes.get(
                    normalizeText(
                        name
                    ).toLowerCase()
                ) ||
                null
            );
        }

        listRoutes(
            options = {}
        ) {
            return this.routeOrder
                .map(
                    name =>
                        this.routes.get(
                            name
                        )
                )
                .filter(
                    route =>
                        route &&
                        (
                            options.includeHidden ===
                                true ||
                            !route.hidden
                        )
                )
                .map(
                    route =>
                        this.serializeRoute(
                            route
                        )
                );
        }

        serializeRoute(
            route
        ) {
            return {
                name:
                    route.name,

                path:
                    route.path,

                title:
                    route.title,

                description:
                    route.description,

                category:
                    route.category,

                redirect:
                    route.redirect,

                hasHandler:
                    Boolean(
                        route.handler
                    ),

                hasView:
                    Boolean(
                        route.view
                    ),

                hasGuard:
                    Boolean(
                        route.guard
                    ),

                middleware:
                    route.middleware.length,

                hidden:
                    route.hidden,

                metadata:
                    safeClone(
                        route.metadata
                    )
            };
        }

        /*
        ======================================================================
        Middleware and Guards
        ======================================================================
        */

        use(
            middleware
        ) {
            if (
                typeof middleware !==
                "function"
            ) {
                throw new TypeError(
                    "Router middleware must be a function."
                );
            }

            this.middleware.push(
                middleware
            );

            return () => {
                const index =
                    this.middleware.indexOf(
                        middleware
                    );

                if (
                    index >=
                    0
                ) {
                    this.middleware.splice(
                        index,
                        1
                    );
                }
            };
        }

        addGuard(
            guard
        ) {
            if (
                typeof guard !==
                "function"
            ) {
                throw new TypeError(
                    "Router guard must be a function."
                );
            }

            this.guards.push(
                guard
            );

            return () => {
                const index =
                    this.guards.indexOf(
                        guard
                    );

                if (
                    index >=
                    0
                ) {
                    this.guards.splice(
                        index,
                        1
                    );
                }
            };
        }

        async runMiddleware(
            navigation
        ) {
            const chain = [
                ...this.middleware,
                ...navigation.route.middleware
            ];

            let index =
                -1;

            const dispatch =
                async position => {
                    if (
                        position <=
                        index
                    ) {
                        throw new Error(
                            "Router middleware called next() more than once."
                        );
                    }

                    index =
                        position;

                    const middleware =
                        chain[
                            position
                        ];

                    if (!middleware) {
                        return navigation;
                    }

                    return middleware(
                        navigation,
                        () =>
                            dispatch(
                                position +
                                1
                            ),
                        this
                    );
                };

            return dispatch(
                0
            );
        }

        async runGuards(
            navigation
        ) {
            const guards = [
                ...this.guards
            ];

            if (
                navigation.route.guard
            ) {
                guards.push(
                    navigation.route.guard
                );
            }

            for (const guard of guards) {
                const result =
                    await guard(
                        navigation,
                        this
                    );

                if (
                    result ===
                    false
                ) {
                    return {
                        allowed:
                            false,
                        redirect:
                            null
                    };
                }

                if (
                    typeof result ===
                    "string"
                ) {
                    return {
                        allowed:
                            false,
                        redirect:
                            result
                    };
                }

                if (
                    result &&
                    typeof result ===
                    "object" &&
                    result.redirect
                ) {
                    return {
                        allowed:
                            false,
                        redirect:
                            result.redirect
                    };
                }
            }

            return {
                allowed:
                    true,
                redirect:
                    null
            };
        }

        /*
        ======================================================================
        Matching and Resolution
        ======================================================================
        */

        match(
            location
        ) {
            const parsed =
                typeof location ===
                    "string"
                    ? splitLocation(
                        location
                    )
                    : {
                        path:
                            normalizePath(
                                location.path
                            ),
                        query:
                            location.query ||
                            {},
                        queryString:
                            stringifyQuery(
                                location.query ||
                                {}
                            ),
                        hash:
                            location.hash ||
                            ""
                    };

            for (const name of this.routeOrder) {
                const route =
                    this.routes.get(
                        name
                    );

                if (!route) {
                    continue;
                }

                const match =
                    parsed.path.match(
                        route.compiled.regex
                    );

                if (!match) {
                    continue;
                }

                return {
                    route,
                    params:
                        decodeParams(
                            route.compiled,
                            match
                        ),
                    path:
                        parsed.path,
                    query:
                        parsed.query,
                    queryString:
                        parsed.queryString,
                    hash:
                        parsed.hash
                };
            }

            const fallback =
                this.getRoute(
                    this.options.notFoundRoute
                );

            if (fallback) {
                return {
                    route:
                        fallback,
                    params: {
                        path:
                            parsed.path
                    },
                    path:
                        parsed.path,
                    query:
                        parsed.query,
                    queryString:
                        parsed.queryString,
                    hash:
                        parsed.hash,
                    notFound:
                        true
                };
            }

            return null;
        }

        resolve(
            target,
            options = {}
        ) {
            if (
                target &&
                typeof target ===
                "object"
            ) {
                if (
                    target.name
                ) {
                    const route =
                        this.getRoute(
                            target.name
                        );

                    if (!route) {
                        throw new Error(
                            `Unknown route: ${target.name}`
                        );
                    }

                    const path =
                        buildPath(
                            route.path,
                            target.params ||
                            {}
                        );

                    return {
                        route,
                        params:
                            target.params ||
                            {},
                        path,
                        query:
                            target.query ||
                            {},
                        queryString:
                            stringifyQuery(
                                target.query ||
                                {}
                            ),
                        hash:
                            target.hash ||
                            "",
                        state:
                            target.state
                    };
                }

                if (
                    target.path
                ) {
                    return this.match({
                        ...target,
                        path:
                            target.path
                    });
                }
            }

            const text =
                normalizeText(
                    target
                );

            const named =
                this.getRoute(
                    text
                );

            if (named) {
                return {
                    route:
                        named,
                    params:
                        options.params ||
                        {},
                    path:
                        buildPath(
                            named.path,
                            options.params ||
                            {}
                        ),
                    query:
                        options.query ||
                        {},
                    queryString:
                        stringifyQuery(
                            options.query ||
                            {}
                        ),
                    hash:
                        options.hash ||
                        "",
                    state:
                        options.state
                };
            }

            return this.match(
                text ||
                "/"
            );
        }

        href(
            target,
            options = {}
        ) {
            const resolved =
                this.resolve(
                    target,
                    options
                );

            if (!resolved) {
                throw new Error(
                    `Unable to resolve route: ${target}`
                );
            }

            const path =
                `${resolved.path}${resolved.queryString || ""}${
                    resolved.hash
                        ? `#${resolved.hash}`
                        : ""
                }`;

            switch (
                this.options.mode
            ) {
                case "hash":
                    return `#${path}`;

                case "history":
                    return (
                        this.options.basePath ===
                            "/"
                            ? path
                            : `${this.options.basePath.replace(/\/$/, "")}${path}`
                    );

                case "memory":
                default:
                    return path;
            }
        }

        /*
        ======================================================================
        Navigation
        ======================================================================
        */

        async navigate(
            target,
            options = {}
        ) {
            if (this.destroyed) {
                throw new Error(
                    "TerminalRouter has been destroyed."
                );
            }

            const resolved =
                this.resolve(
                    target,
                    options
                );

            if (!resolved) {
                throw new Error(
                    `No route matches: ${normalizeText(target)}`
                );
            }

            if (
                resolved.route.redirect
            ) {
                const redirect =
                    typeof resolved.route.redirect ===
                    "function"
                        ? await resolved.route.redirect(
                            resolved,
                            this
                        )
                        : resolved.route.redirect;

                return this.navigate(
                    redirect,
                    {
                        ...options,
                        replace:
                            true,
                        redirectedFrom:
                            resolved.path
                    }
                );
            }

            const navigation = {
                id:
                    makeNavigationID(),

                route:
                    resolved.route,

                name:
                    resolved.route.name,

                path:
                    resolved.path,

                params:
                    safeClone(
                        resolved.params ||
                        {}
                    ),

                query:
                    safeClone(
                        resolved.query ||
                        {}
                    ),

                queryString:
                    resolved.queryString ||
                    stringifyQuery(
                        resolved.query ||
                        {}
                    ),

                hash:
                    resolved.hash ||
                    "",

                state:
                    safeClone(
                        options.state ??
                        resolved.state ??
                        null
                    ),

                replace:
                    options.replace ===
                    true,

                silent:
                    options.silent ===
                    true,

                source:
                    options.source ||
                    "programmatic",

                redirectedFrom:
                    options.redirectedFrom ||
                    null,

                notFound:
                    Boolean(
                        resolved.notFound
                    ),

                previous:
                    this.current
                        ? safeClone(
                            this.current
                        )
                        : null,

                timestamp:
                    new Date().toISOString()
            };

            this.emit(
                "before-navigate",
                {
                    navigation
                }
            );

            const guard =
                await this.runGuards(
                    navigation
                );

            if (
                !guard.allowed
            ) {
                this.emit(
                    "navigation-blocked",
                    {
                        navigation,
                        redirect:
                            guard.redirect
                    }
                );

                if (
                    guard.redirect
                ) {
                    return this.navigate(
                        guard.redirect,
                        {
                            replace:
                                true,
                            redirectedFrom:
                                navigation.path,
                            source:
                                "guard"
                        }
                    );
                }

                return null;
            }

            const processed =
                await this.runMiddleware(
                    navigation
                );

            if (
                processed ===
                false ||
                processed ===
                null
            ) {
                return null;
            }

            const activeNavigation =
                processed &&
                typeof processed ===
                "object"
                    ? processed
                    : navigation;

            const result =
                await this.executeRoute(
                    activeNavigation
                );

            activeNavigation.result =
                result;

            this.current =
                activeNavigation;

            this.recordHistory(
                activeNavigation,
                {
                    replace:
                        activeNavigation.replace
                }
            );

            if (
                this.options.syncBrowser &&
                options.browser !==
                false
            ) {
                this.syncBrowser(
                    activeNavigation
                );
            }

            if (
                !this.options.preserveScroll &&
                this.viewHost
            ) {
                this.viewHost.scrollTop =
                    0;
            }

            this.emit(
                "after-navigate",
                {
                    navigation:
                        activeNavigation,
                    result
                }
            );

            return activeNavigation;
        }

        async executeRoute(
            navigation
        ) {
            const route =
                navigation.route;

            let result =
                null;

            if (
                route.handler
            ) {
                result =
                    await route.handler(
                        navigation,
                        this.context,
                        this
                    );
            }

            if (
                route.view
            ) {
                const view =
                    typeof route.view ===
                    "function"
                        ? await route.view(
                            navigation,
                            this.context,
                            this
                        )
                        : route.view;

                await this.mountView(
                    view,
                    navigation
                );

                if (
                    result ===
                    null ||
                    result ===
                    undefined
                ) {
                    result =
                        view;
                }
            }

            return result;
        }

        async mountView(
            view,
            navigation
        ) {
            const host =
                this.viewHost ||
                this.resolveViewHost();

            if (!host) {
                return null;
            }

            let node =
                view;

            if (
                typeof node ===
                "string"
            ) {
                const wrapper =
                    document.createElement(
                        "div"
                    );

                wrapper.textContent =
                    node;

                node =
                    wrapper;
            }

            if (
                node &&
                typeof node.then ===
                "function"
            ) {
                node =
                    await node;
            }

            host.replaceChildren();

            if (
                node instanceof
                Node
            ) {
                host.appendChild(
                    node
                );
            } else if (
                node !==
                null &&
                node !==
                undefined
            ) {
                const pre =
                    document.createElement(
                        "pre"
                    );

                pre.textContent =
                    typeof node ===
                    "string"
                        ? node
                        : JSON.stringify(
                            node,
                            null,
                            2
                        );

                host.appendChild(
                    pre
                );
            }

            host.dataset.route =
                navigation.name;

            host.dataset.routePath =
                navigation.path;

            this.emit(
                "view-mounted",
                {
                    navigation,
                    view:
                        node,
                    host
                }
            );

            return node;
        }

        recordHistory(
            navigation,
            options = {}
        ) {
            const entry = {
                id:
                    navigation.id,

                name:
                    navigation.name,

                path:
                    navigation.path,

                params:
                    safeClone(
                        navigation.params
                    ),

                query:
                    safeClone(
                        navigation.query
                    ),

                hash:
                    navigation.hash,

                state:
                    safeClone(
                        navigation.state
                    ),

                source:
                    navigation.source,

                timestamp:
                    navigation.timestamp
            };

            if (
                options.replace &&
                this.historyIndex >=
                    0
            ) {
                this.history[
                    this.historyIndex
                ] =
                    entry;

                return entry;
            }

            if (
                this.historyIndex <
                this.history.length -
                    1
            ) {
                this.history =
                    this.history.slice(
                        0,
                        this.historyIndex +
                        1
                    );
            }

            this.history.push(
                entry
            );

            this.history =
                this.history.slice(
                    -this.options.maximumHistory
                );

            this.historyIndex =
                this.history.length -
                1;

            return entry;
        }

        async back() {
            if (
                this.options.syncBrowser &&
                this.options.mode !==
                "memory"
            ) {
                window.history.back();

                return null;
            }

            if (
                this.historyIndex <=
                0
            ) {
                return null;
            }

            this.historyIndex -=
                1;

            const entry =
                this.history[
                    this.historyIndex
                ];

            return this.navigate(
                {
                    name:
                        entry.name,
                    params:
                        entry.params,
                    query:
                        entry.query,
                    hash:
                        entry.hash,
                    state:
                        entry.state
                },
                {
                    replace:
                        true,
                    browser:
                        false,
                    source:
                        "back"
                }
            );
        }

        async forward() {
            if (
                this.options.syncBrowser &&
                this.options.mode !==
                "memory"
            ) {
                window.history.forward();

                return null;
            }

            if (
                this.historyIndex >=
                this.history.length -
                    1
            ) {
                return null;
            }

            this.historyIndex +=
                1;

            const entry =
                this.history[
                    this.historyIndex
                ];

            return this.navigate(
                {
                    name:
                        entry.name,
                    params:
                        entry.params,
                    query:
                        entry.query,
                    hash:
                        entry.hash,
                    state:
                        entry.state
                },
                {
                    replace:
                        true,
                    browser:
                        false,
                    source:
                        "forward"
                }
            );
        }

        /*
        ======================================================================
        Browser Integration
        ======================================================================
        */

        currentBrowserLocation() {
            switch (
                this.options.mode
            ) {
                case "hash":
                    return (
                        window.location.hash.slice(
                            1
                        ) ||
                        "/"
                    );

                case "history": {
                    let path =
                        window.location.pathname;

                    const base =
                        this.options.basePath.replace(
                            /\/$/,
                            ""
                        );

                    if (
                        base &&
                        base !==
                            "/" &&
                        path.startsWith(
                            base
                        )
                    ) {
                        path =
                            path.slice(
                                base.length
                            ) ||
                            "/";
                    }

                    return (
                        `${path}${window.location.search}${window.location.hash}`
                    );
                }

                case "memory":
                default:
                    return "/";
            }
        }

        restoreFromBrowser() {
            if (
                !this.options.syncBrowser ||
                this.options.mode ===
                "memory"
            ) {
                return null;
            }

            return this.currentBrowserLocation();
        }

        syncBrowser(
            navigation
        ) {
            const href =
                this.href({
                    name:
                        navigation.name,
                    params:
                        navigation.params,
                    query:
                        navigation.query,
                    hash:
                        navigation.hash
                });

            const state = {
                speciedexTerminalRouter:
                    true,

                navigation:
                    {
                        id:
                            navigation.id,
                        name:
                            navigation.name,
                        params:
                            navigation.params,
                        query:
                            navigation.query,
                        hash:
                            navigation.hash,
                        state:
                            navigation.state
                    }
            };

            if (
                this.options.mode ===
                "hash"
            ) {
                if (
                    navigation.replace
                ) {
                    window.history.replaceState(
                        state,
                        "",
                        href
                    );
                } else {
                    window.history.pushState(
                        state,
                        "",
                        href
                    );
                }

                return;
            }

            if (
                this.options.mode ===
                "history"
            ) {
                const method =
                    navigation.replace
                        ? "replaceState"
                        : "pushState";

                window.history[
                    method
                ](
                    state,
                    "",
                    href
                );
            }
        }

        async handleBrowserNavigation(
            event
        ) {
            const state =
                event.state?.
                    navigation ||
                null;

            if (
                state?.name
            ) {
                await this.navigate(
                    state,
                    {
                        replace:
                            true,
                        browser:
                            false,
                        source:
                            "browser"
                    }
                );

                return;
            }

            await this.navigate(
                this.currentBrowserLocation(),
                {
                    replace:
                        true,
                    browser:
                        false,
                    source:
                        "browser"
                }
            );
        }

        handleLinkClick(
            event
        ) {
            if (
                !this.options.interceptLinks ||
                event.defaultPrevented ||
                event.button !==
                    0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
            ) {
                return;
            }

            const anchor =
                event.target.closest(
                    "a[data-terminal-route], a[data-router-link]"
                );

            if (!anchor) {
                return;
            }

            const route =
                anchor.dataset.terminalRoute ||
                anchor.dataset.routerLink ||
                anchor.getAttribute(
                    "href"
                );

            if (!route) {
                return;
            }

            event.preventDefault();

            this.navigate(
                route,
                {
                    source:
                        "link"
                }
            ).catch(
                error => {
                    console.error(
                        "[SpeciedexTerminalRouter] Link navigation failed:",
                        error
                    );
                }
            );
        }

        /*
        ======================================================================
        Lifecycle
        ======================================================================
        */

        start() {
            if (this.started) {
                return false;
            }

            this.started =
                true;

            if (
                this.options.syncBrowser
            ) {
                if (
                    this.options.mode ===
                    "history"
                ) {
                    window.addEventListener(
                        "popstate",
                        this.boundPopState
                    );
                }

                if (
                    this.options.mode ===
                    "hash"
                ) {
                    window.addEventListener(
                        "hashchange",
                        this.boundHashChange
                    );
                }
            }

            if (
                this.options.interceptLinks
            ) {
                document.addEventListener(
                    "click",
                    this.boundClick
                );
            }

            const initial =
                this.options.restore
                    ? this.restoreFromBrowser()
                    : null;

            const target =
                initial ||
                this.options.defaultRoute;

            this.navigate(
                target,
                {
                    replace:
                        this.options.replaceInitial,
                    source:
                        "start"
                }
            ).catch(
                error => {
                    console.error(
                        "[SpeciedexTerminalRouter] Initial navigation failed:",
                        error
                    );
                }
            );

            this.emit(
                "started",
                {
                    mode:
                        this.options.mode
                }
            );

            return true;
        }

        stop() {
            if (!this.started) {
                return false;
            }

            window.removeEventListener(
                "popstate",
                this.boundPopState
            );

            window.removeEventListener(
                "hashchange",
                this.boundHashChange
            );

            document.removeEventListener(
                "click",
                this.boundClick
            );

            this.started =
                false;

            this.emit(
                "stopped",
                {}
            );

            return true;
        }

        resolveViewHost() {
            return (
                this.context.root?.
                    querySelector?.(
                        "[data-terminal-router-view]"
                    ) ||
                this.context.root?.
                    querySelector?.(
                        "[data-terminal-renderer-mount]"
                    ) ||
                null
            );
        }

        setViewHost(
            element
        ) {
            if (
                element !==
                    null &&
                !(element instanceof Element)
            ) {
                throw new TypeError(
                    "Router view host must be an Element or null."
                );
            }

            this.viewHost =
                element;

            return element;
        }

        status() {
            return {
                version:
                    VERSION,

                started:
                    this.started,

                mode:
                    this.options.mode,

                basePath:
                    this.options.basePath,

                syncBrowser:
                    this.options.syncBrowser,

                interceptLinks:
                    this.options.interceptLinks,

                routes:
                    this.routes.size,

                middleware:
                    this.middleware.length,

                guards:
                    this.guards.length,

                history:
                    this.history.length,

                historyIndex:
                    this.historyIndex,

                current:
                    this.current
                        ? {
                            id:
                                this.current.id,
                            name:
                                this.current.name,
                            path:
                                this.current.path,
                            params:
                                safeClone(
                                    this.current.params
                                ),
                            query:
                                safeClone(
                                    this.current.query
                                ),
                            hash:
                                this.current.hash,
                            source:
                                this.current.source,
                            timestamp:
                                this.current.timestamp
                        }
                        : null
            };
        }

        async run(
            parameters = {}
        ) {
            const args =
                Array.isArray(
                    parameters.args
                )
                    ? [
                        ...parameters.args
                    ]
                    : [];

            const action =
                normalizeText(
                    parameters.action ||
                    args.shift() ||
                    "status"
                ).toLowerCase();

            switch (action) {
                case "list":
                case "routes":
                    return this.listRoutes();

                case "current":
                    return this.current;

                case "history":
                    return {
                        index:
                            this.historyIndex,
                        entries:
                            [
                                ...this.history
                            ]
                    };

                case "back":
                    return this.back();

                case "forward":
                    return this.forward();

                case "go":
                case "navigate":
                    return this.navigate(
                        args.join(
                            " "
                        ) ||
                        this.options.defaultRoute
                    );

                case "status":
                default:
                    return this.status();
            }
        }

        emit(
            type,
            detail = {}
        ) {
            this.dispatchEvent(
                new CustomEvent(
                    type,
                    {
                        detail
                    }
                )
            );

            this.context.events?.emit?.(
                `router:${type}`,
                detail
            );

            this.context.root?.
                dispatchEvent?.(
                    new CustomEvent(
                        `speciedex:terminal-router-${type}`,
                        {
                            bubbles:
                                true,

                            detail
                        }
                    )
                );

            document.dispatchEvent(
                new CustomEvent(
                    `speciedex:terminal-router-${type}`,
                    {
                        detail
                    }
                )
            );
        }

        destroy() {
            if (this.destroyed) {
                return;
            }

            this.stop();

            this.routes.clear();
            this.routeOrder =
                [];
            this.middleware =
                [];
            this.guards =
                [];
            this.history =
                [];
            this.current =
                null;
            this.destroyed =
                true;

            this.dispatchEvent(
                new CustomEvent(
                    "destroy"
                )
            );
        }

        /*
        ======================================================================
        Built-in Routes
        ======================================================================
        */

        registerBuiltins() {
            this.register({
                name:
                    "home",

                path:
                    "/",

                title:
                    "Terminal Home",

                description:
                    "SpeciedexTerminal default route.",

                category:
                    "system",

                handler:
                    navigation => ({
                        route:
                            navigation.name,
                        path:
                            navigation.path,
                        message:
                            "SpeciedexTerminal router is ready."
                    })
            });

            this.register({
                name:
                    "search",

                path:
                    "/search/:query?",

                title:
                    "Search",

                description:
                    "Route to Speciedex search.",

                category:
                    "data",

                handler:
                    async (
                        navigation,
                        context
                    ) => {
                        const query =
                            navigation.params.query ||
                            navigation.query.q ||
                            "";

                        if (
                            !query
                        ) {
                            return {
                                route:
                                    "search",
                                query:
                                    "",
                                results:
                                    []
                            };
                        }

                        const service =
                            context.search;

                        if (
                            !service?.search
                        ) {
                            return {
                                route:
                                    "search",
                                query,
                                error:
                                    "Search service unavailable."
                            };
                        }

                        const results =
                            await service.search(
                                query,
                                {
                                    limit:
                                        navigation.query.limit ||
                                        50
                                }
                            );

                        return {
                            route:
                                "search",
                            query,
                            results
                        };
                    }
            });

            this.register({
                name:
                    "provider",

                path:
                    "/provider/:id",

                title:
                    "Provider",

                description:
                    "Inspect one provider.",

                category:
                    "provider",

                handler:
                    (
                        navigation,
                        context
                    ) => {
                        const id =
                            navigation.params.id;

                        return (
                            context.providerManager?.
                                get?.(
                                    id
                                ) ||
                            context.providerHealth?.
                                evaluate?.(
                                    id
                                ) ||
                            {
                                provider:
                                    id,
                                error:
                                    "Provider services unavailable."
                            }
                        );
                    }
            });

            this.register({
                name:
                    "map",

                path:
                    "/map/:collection?",

                title:
                    "Map",

                description:
                    "Render a map from a terminal collection.",

                category:
                    "visualization",

                view:
                    (
                        navigation,
                        context
                    ) => {
                        const collection =
                            navigation.params.collection ||
                            "records";

                        const data =
                            context.library?.
                                get?.(
                                    collection
                                ) ||
                            [];

                        if (
                            !context.mapRenderer?.
                                render
                        ) {
                            const pre =
                                document.createElement(
                                    "pre"
                                );

                            pre.textContent =
                                "Map renderer unavailable.";

                            return pre;
                        }

                        return context.mapRenderer.render(
                            data,
                            {
                                title:
                                    `Speciedex Map: ${collection}`
                            }
                        );
                    }
            });

            this.register({
                name:
                    "matrix",

                path:
                    "/matrix/:collection?",

                title:
                    "Matrix",

                description:
                    "Render a matrix from a terminal collection.",

                category:
                    "visualization",

                view:
                    (
                        navigation,
                        context
                    ) => {
                        const collection =
                            navigation.params.collection ||
                            "records";

                        const data =
                            context.library?.
                                get?.(
                                    collection
                                ) ||
                            [];

                        if (
                            !context.matrixRenderer?.
                                render
                        ) {
                            const pre =
                                document.createElement(
                                    "pre"
                                );

                            pre.textContent =
                                "Matrix renderer unavailable.";

                            return pre;
                        }

                        return context.matrixRenderer.render(
                            data,
                            {
                                title:
                                    `Speciedex Matrix: ${collection}`
                            }
                        );
                    }
            });

            this.register({
                name:
                    "not-found",

                path:
                    "/__not-found__",

                title:
                    "Not Found",

                description:
                    "Fallback route for unknown locations.",

                category:
                    "system",

                hidden:
                    true,

                handler:
                    navigation => ({
                        route:
                            "not-found",
                        path:
                            navigation.params.path ||
                            navigation.path,
                        error:
                            "No matching terminal route."
                    })
            });
        }
    }

    /*
    ==========================================================================
    Initialization
    ==========================================================================
    */

    function initialize(
        context
    ) {
        if (
            context.router instanceof
            TerminalRouter
        ) {
            return context.router;
        }

        const root =
            context.root;

        const router =
            new TerminalRouter(
                context,
                {
                    mode:
                        root?.
                            dataset.
                            terminalRouterMode ||
                        DEFAULT_OPTIONS.mode,

                    basePath:
                        root?.
                            dataset.
                            terminalRouterBase ||
                        DEFAULT_OPTIONS.basePath,

                    syncBrowser:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalRouterSyncBrowser,
                            false
                        ),

                    interceptLinks:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalRouterInterceptLinks,
                            false
                        ),

                    restore:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalRouterRestore,
                            false
                        ),

                    maximumHistory:
                        clampInteger(
                            root?.
                                dataset.
                                terminalRouterHistory,
                            DEFAULT_OPTIONS.maximumHistory,
                            10,
                            5000
                        ),

                    defaultRoute:
                        root?.
                            dataset.
                            terminalRouterDefault ||
                        DEFAULT_OPTIONS.defaultRoute,

                    notFoundRoute:
                        root?.
                            dataset.
                            terminalRouterNotFound ||
                        DEFAULT_OPTIONS.notFoundRoute
                }
            );

        context.router =
            router;

        context.registerService?.(
            "router",
            router
        );

        if (
            parseBoolean(
                root?.
                    dataset.
                    terminalRouterAutoStart,
                true
            )
        ) {
            router.start();
        }

        return router;
    }

    /*
    ==========================================================================
    Commands
    ==========================================================================
    */

    const commands =
        [
            {
                name:
                    "router",

                category:
                    "system",

                description:
                    "Inspect or control terminal routing.",

                usage:
                    "router [status|routes|current|history|back|forward|go <route>]",

                handler: async ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const service =
                        context.services?.get?.(
                            "router"
                        ) ||
                        context.router;

                    if (!service) {
                        throw new Error(
                            "Router service is unavailable."
                        );
                    }

                    return writeJSON(
                        await service.run({
                            args
                        })
                    );
                }
            },

            {
                name:
                    "route",

                category:
                    "system",

                description:
                    "Navigate to a named route or path.",

                usage:
                    "route <name-or-path> [--replace]",

                handler: async ({
                    args,
                    parsed,
                    context,
                    writeJSON
                }) => {
                    const target =
                        args.join(
                            " "
                        );

                    if (!target) {
                        throw new Error(
                            "A route name or path is required."
                        );
                    }

                    const navigation =
                        await context.router.navigate(
                            target,
                            {
                                replace:
                                    parsed.flags.replace ===
                                    true,
                                source:
                                    "command"
                            }
                        );

                    return writeJSON(
                        navigation
                    );
                }
            },

            {
                name:
                    "route-list",

                category:
                    "system",

                description:
                    "List registered routes.",

                usage:
                    "route-list [--all]",

                handler: ({
                    parsed,
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.router.listRoutes({
                            includeHidden:
                                parsed.flags.all ===
                                true
                        })
                    )
            },

            {
                name:
                    "route-current",

                category:
                    "system",

                description:
                    "Display the current route.",

                usage:
                    "route-current",

                handler: ({
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.router.current
                    )
            },

            {
                name:
                    "route-back",

                category:
                    "system",

                description:
                    "Navigate backward.",

                usage:
                    "route-back",

                handler: async ({
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        await context.router.back()
                    )
            },

            {
                name:
                    "route-forward",

                category:
                    "system",

                description:
                    "Navigate forward.",

                usage:
                    "route-forward",

                handler: async ({
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        await context.router.forward()
                    )
            },

            {
                name:
                    "route-history",

                category:
                    "system",

                description:
                    "Display router navigation history.",

                usage:
                    "route-history",

                handler: ({
                    context,
                    writeJSON
                }) =>
                    writeJSON({
                        index:
                            context.router.historyIndex,
                        entries:
                            context.router.history
                    })
            },

            {
                name:
                    "route-href",

                category:
                    "system",

                description:
                    "Generate a route URL.",

                usage:
                    "route-href <name-or-path>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const target =
                        args.join(
                            " "
                        );

                    if (!target) {
                        throw new Error(
                            "A route name or path is required."
                        );
                    }

                    return write(
                        context.router.href(
                            target
                        )
                    );
                }
            },

            {
                name:
                    "route-register",

                category:
                    "system",

                description:
                    "Register a simple runtime route.",

                usage:
                    "route-register <name> <path> [title]",

                handler: ({
                    args,
                    context,
                    writeJSON
                }) => {
                    const name =
                        args.shift();

                    const path =
                        args.shift();

                    const title =
                        args.join(
                            " "
                        ) ||
                        name;

                    if (
                        !name ||
                        !path
                    ) {
                        throw new Error(
                            "Usage: route-register <name> <path> [title]"
                        );
                    }

                    const route =
                        context.router.register({
                            name,
                            path,
                            title,
                            description:
                                "Runtime route registered from SpeciedexTerminal.",
                            handler:
                                navigation => ({
                                    route:
                                        navigation.name,
                                    path:
                                        navigation.path,
                                    params:
                                        navigation.params,
                                    query:
                                        navigation.query
                                })
                        });

                    return writeJSON(
                        context.router.serializeRoute(
                            route
                        )
                    );
                }
            },

            {
                name:
                    "route-unregister",

                category:
                    "system",

                description:
                    "Unregister a route.",

                usage:
                    "route-unregister <name>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const name =
                        args[0];

                    if (!name) {
                        throw new Error(
                            "A route name is required."
                        );
                    }

                    const removed =
                        context.router.unregister(
                            name
                        );

                    return write(
                        removed
                            ? `Route removed: ${name}`
                            : `Route not found: ${name}`,
                        removed
                            ? "success"
                            : "warning"
                    );
                }
            }
        ];

    /*
    ==========================================================================
    Public Module API
    ==========================================================================
    */

    const api =
        Object.freeze({
            name:
                MODULE_NAME,

            version:
                VERSION,

            DEFAULT_OPTIONS,
            TerminalRouter,

            normalizeText,
            parseBoolean,
            clampInteger,
            normalizeMode,
            normalizePath,
            normalizeBasePath,
            parseQuery,
            stringifyQuery,
            splitLocation,
            compilePath,
            buildPath,
            decodeParams,
            safeClone,

            initialize,
            mount:
                initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalRouter =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] =
        api;

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
