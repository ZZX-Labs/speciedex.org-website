/*
========================================================================
Speciedex.org
Terminal Animation Renderer
========================================================================

Canonical GIF animation renderer for SpeciedexTerminal loading and progress
interfaces.

Default visual sequence:

    loading-ring.gif
    pulsing one / two / three-dot indicator
    tortoise.gif
    rabbit.gif
    cheetah.gif
    dolphin.gif
    "Please wait, Loading..."

Supported creature layouts:

    horizontal
        Four or more creature GIFs remain in one bounded horizontal row.
        On narrow screens the row scrolls horizontally instead of stacking.

    circular
        Four or more creature GIFs orbit clockwise around a circular track.
        Each creature counter-rotates so it remains visually upright.

Alternate creature sets may be registered at initialization time or later
through the public service API.

Canonical asset root:

    /static/images/terminal/loading/

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Animation";

    const VERSION =
        "1.0.0";

    const PRIMARY_COLOR =
        "#c0d674";

    const DEFAULT_ASSET_ROOT =
        "/static/images/terminal/loading/";

    const INSTANCE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.animation.instance"
        );

    const SERVICE_SYMBOL =
        Symbol.for(
            "speciedex.terminal.animation.service"
        );

    const activeDispatches =
        new WeakMap();

    const RESERVED_KEYS =
        new Set([
            "__proto__",
            "prototype",
            "constructor"
        ]);

    const DEFAULT_CREATURE_SETS =
        Object.freeze({
            runners:
                Object.freeze([
                    Object.freeze({
                        name:
                            "tortoise",

                        label:
                            "Tortoise",

                        src:
                            "tortoise.gif",

                        alt:
                            "Tortoise running animation"
                    }),

                    Object.freeze({
                        name:
                            "rabbit",

                        label:
                            "Rabbit",

                        src:
                            "rabbit.gif",

                        alt:
                            "Rabbit running animation"
                    }),

                    Object.freeze({
                        name:
                            "cheetah",

                        label:
                            "Cheetah",

                        src:
                            "cheetah.gif",

                        alt:
                            "Cheetah running animation"
                    }),

                    Object.freeze({
                        name:
                            "dolphin",

                        label:
                            "Dolphin",

                        src:
                            "dolphin.gif",

                        alt:
                            "Dolphin swimming animation"
                    })
                ])
        });

    const DEFAULT_OPTIONS =
        Object.freeze({
            assetRoot:
                DEFAULT_ASSET_ROOT,

            ring:
                "loading-ring.gif",

            creatureSet:
                "runners",

            creatureSets:
                DEFAULT_CREATURE_SETS,

            layout:
                "horizontal",

            message:
                "Please wait, Loading",

            showRing:
                true,

            showDots:
                true,

            showMessage:
                true,

            showCreatureLabels:
                false,

            creatureCount:
                4,

            rotateDuration:
                14,

            compact:
                false,

            injectStyles:
                true,

            reducedMotion:
                false,

            ariaLive:
                "polite",

            role:
                "status",

            hidden:
                false
        });

    function isObject(value) {
        return (
            value !==
                null &&
            typeof value ===
                "object" &&
            !Array.isArray(
                value
            )
        );
    }

    function safeClone(
        value,
        seen = new WeakMap(),
        depth = 0
    ) {
        if (
            value ===
                null ||
            value ===
                undefined ||
            typeof value !==
                "object"
        ) {
            return typeof value ===
                "bigint"
                ? String(
                    value
                )
                : value;
        }

        if (depth > 24) {
            return "[Truncated]";
        }

        if (
            seen.has(
                value
            )
        ) {
            return "[Circular]";
        }

        seen.set(
            value,
            true
        );

        if (
            value instanceof
                Error
        ) {
            return {
                name:
                    value.name,

                message:
                    value.message,

                stack:
                    value.stack ||
                    null
            };
        }

        if (
            value instanceof
                Date
        ) {
            return value.toISOString();
        }

        if (
            Array.isArray(
                value
            )
        ) {
            return value.map(
                item =>
                    safeClone(
                        item,
                        seen,
                        depth +
                        1
                    )
            );
        }

        const output =
            {};

        for (
            const [
                key,
                item
            ] of Object.entries(
                value
            )
        ) {
            if (
                RESERVED_KEYS.has(
                    key
                )
            ) {
                continue;
            }

            output[
                key
            ] =
                safeClone(
                    item,
                    seen,
                    depth +
                    1
                );
        }

        return output;
    }

    function safeDispatch(
        target,
        name,
        detail =
            {},
        options =
            {}
    ) {
        if (
            !target ||
            typeof target.dispatchEvent !==
                "function" ||
            !name
        ) {
            return false;
        }

        let names =
            activeDispatches.get(
                target
            );

        if (!names) {
            names =
                new Set();

            activeDispatches.set(
                target,
                names
            );
        }

        if (
            names.has(
                name
            )
        ) {
            return false;
        }

        names.add(
            name
        );

        try {
            return target.dispatchEvent(
                new CustomEvent(
                    name,
                    {
                        bubbles:
                            options.bubbles ===
                            true,

                        cancelable:
                            options.cancelable ===
                            true,

                        detail
                    }
                )
            );
        } catch (_error) {
            return false;
        } finally {
            names.delete(
                name
            );
        }
    }

    function parseBoolean(
        value,
        fallback =
            false
    ) {
        if (
            typeof value ===
                "boolean"
        ) {
            return value;
        }

        if (
            value ===
                undefined ||
            value ===
                null ||
            value ===
                ""
        ) {
            return fallback;
        }

        const normalized =
            String(
                value
            )
                .trim()
                .toLowerCase();

        if (
            [
                "1",
                "true",
                "yes",
                "on",
                "enabled"
            ].includes(
                normalized
            )
        ) {
            return true;
        }

        if (
            [
                "0",
                "false",
                "no",
                "off",
                "disabled"
            ].includes(
                normalized
            )
        ) {
            return false;
        }

        return fallback;
    }

    function finiteNumber(
        value,
        fallback,
        minimum =
            -Infinity,
        maximum =
            Infinity
    ) {
        const numeric =
            Number(
                value
            );

        if (
            !Number.isFinite(
                numeric
            )
        ) {
            return fallback;
        }

        return Math.min(
            maximum,
            Math.max(
                minimum,
                numeric
            )
        );
    }

    function normalizeLayout(
        value
    ) {
        return String(
            value ||
            ""
        )
            .trim()
            .toLowerCase() ===
            "circular"
            ? "circular"
            : "horizontal";
    }

    function normalizeName(
        value,
        fallback =
            "creature"
    ) {
        const normalized =
            String(
                value ||
                fallback
            )
                .trim()
                .toLowerCase()
                .replace(
                    /[^a-z0-9_-]+/g,
                    "-"
                )
                .replace(
                    /^-+|-+$/g,
                    ""
                );

        return normalized ||
            fallback;
    }

    function normalizeCreature(
        creature,
        index =
            0
    ) {
        const source =
            isObject(
                creature
            )
                ? creature
                : {
                    src:
                        String(
                            creature ||
                            ""
                        )
                };

        const name =
            normalizeName(
                source.name ||
                source.label ||
                `creature-${index + 1}`,
                `creature-${index + 1}`
            );

        const label =
            String(
                source.label ||
                source.name ||
                `Creature ${index + 1}`
            );

        const src =
            String(
                source.src ||
                source.gif ||
                ""
            ).trim();

        if (!src) {
            throw new Error(
                `Animation creature "${name}" requires a GIF source.`
            );
        }

        return {
            name,
            label,
            src,
            alt:
                String(
                    source.alt ||
                    `${label} running animation`
                ),
            metadata:
                isObject(
                    source.metadata
                )
                    ? safeClone(
                        source.metadata
                    )
                    : {}
        };
    }

    function normalizeCreatureSet(
        value
    ) {
        if (
            !Array.isArray(
                value
            )
        ) {
            return [];
        }

        return value.map(
            (
                creature,
                index
            ) =>
                normalizeCreature(
                    creature,
                    index
                )
        );
    }

    function mergeCreatureSets(
        customSets
    ) {
        const sets =
            new Map();

        for (
            const [
                name,
                creatures
            ] of Object.entries(
                DEFAULT_CREATURE_SETS
            )
        ) {
            sets.set(
                normalizeName(
                    name,
                    "runners"
                ),
                normalizeCreatureSet(
                    creatures
                )
            );
        }

        if (
            isObject(
                customSets
            )
        ) {
            for (
                const [
                    name,
                    creatures
                ] of Object.entries(
                    customSets
                )
            ) {
                const normalized =
                    normalizeCreatureSet(
                        creatures
                    );

                if (
                    normalized.length
                ) {
                    sets.set(
                        normalizeName(
                            name,
                            "set"
                        ),
                        normalized
                    );
                }
            }
        }

        return sets;
    }

    function joinAsset(
        root,
        path
    ) {
        const base =
            String(
                root ||
                DEFAULT_ASSET_ROOT
            );

        const asset =
            String(
                path ||
                ""
            );

        try {
            return new URL(
                asset,
                new URL(
                    base,
                    window.location?.
                        origin ||
                    document.baseURI ||
                    "http://localhost/"
                )
            ).href;
        } catch (_error) {
            const normalizedRoot =
                base.endsWith(
                    "/"
                )
                    ? base
                    : `${base}/`;

            return (
                normalizedRoot +
                asset.replace(
                    /^\/+/,
                    ""
                )
            );
        }
    }

    function prefersReducedMotion() {
        return Boolean(
            window.matchMedia &&
            window.matchMedia(
                "(prefers-reduced-motion: reduce)"
            ).matches
        );
    }

    function injectAnimationStyles() {
        if (
            document.getElementById(
                "speciedex-terminal-animation-styles"
            )
        ) {
            return false;
        }

        const style =
            document.createElement(
                "style"
            );

        style.id =
            "speciedex-terminal-animation-styles";

        style.textContent = `
            .terminal-animation {
                --terminal-animation-color: ${PRIMARY_COLOR};
                --terminal-animation-count: 4;
                --terminal-animation-rotation: 14s;
                --terminal-animation-orbit-size: min(78vw, 28rem);
                position: relative !important;
                inset: auto !important;
                z-index: auto !important;
                display: grid !important;
                width: 100%;
                max-width: 72rem;
                min-width: 0;
                min-height: 0;
                margin: 0 auto;
                padding: 0.8rem 0;
                gap: 0.8rem;
                align-items: center;
                justify-items: center;
                overflow: hidden;
                color: var(--terminal-animation-color);
                background: transparent;
                text-align: center;
                contain: layout paint;
                isolation: isolate;
            }

            .terminal-animation[hidden] {
                display: none !important;
            }

            .terminal-animation-ring-wrap {
                position: relative;
                display: grid;
                width: 7rem;
                height: 7rem;
                min-width: 7rem;
                min-height: 7rem;
                margin: 0 auto;
                place-items: center;
                overflow: hidden;
            }

            .terminal-animation-ring {
                position: absolute;
                inset: 0;
                display: block;
                width: 100%;
                height: 100%;
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
                image-rendering: pixelated;
                image-rendering: crisp-edges;
                filter:
                    drop-shadow(
                        0 0 0.35rem
                        rgba(192, 214, 116, 0.34)
                    );
                transform: translateZ(0);
                backface-visibility: hidden;
                user-select: none;
                pointer-events: none;
            }

            .terminal-animation-ring-wrap[data-asset-state="missing"]
            .terminal-animation-ring {
                display: none;
            }

            .terminal-animation-ring-fallback {
                display: none;
                color: var(--terminal-animation-color);
                font-size: 0.72rem;
                letter-spacing: 0.08em;
                text-transform: uppercase;
            }

            .terminal-animation-ring-wrap[data-asset-state="missing"]
            .terminal-animation-ring-fallback {
                display: inline;
            }

            .terminal-animation-dots {
                display: inline-flex;
                min-width: 3.4rem;
                min-height: 1.2rem;
                margin: 0 auto;
                align-items: center;
                justify-content: center;
                gap: 0.45rem;
                color: var(--terminal-animation-color);
            }

            .terminal-animation-dot {
                display: inline-block;
                width: 0.5rem;
                height: 0.5rem;
                border-radius: 50%;
                background: currentColor;
                opacity: 0.18;
                transform: scale(0.7);
                animation:
                    speciedex-terminal-animation-dot
                    1.35s ease-in-out infinite;
                box-shadow:
                    0 0 0.35rem
                    rgba(192, 214, 116, 0.24);
            }

            .terminal-animation-dot:nth-child(2) {
                animation-delay: 0.2s;
            }

            .terminal-animation-dot:nth-child(3) {
                animation-delay: 0.4s;
            }

            .terminal-animation-creatures {
                position: relative;
                width: 100%;
                min-width: 0;
                margin: 0 auto;
            }

            .terminal-animation[data-layout="horizontal"]
            .terminal-animation-creatures {
                display: grid !important;
                grid-template-columns:
                    repeat(
                        var(--terminal-animation-count),
                        minmax(0, 1fr)
                    ) !important;
                grid-auto-flow: column;
                align-items: end;
                justify-content: center;
                gap: clamp(0.45rem, 2vw, 1.4rem);
                max-width: 68rem;
                overflow-x: auto;
                overflow-y: hidden;
                overscroll-behavior-x: contain;
                scrollbar-width: thin;
                scrollbar-color:
                    rgba(192, 214, 116, 0.36)
                    transparent;
            }

            .terminal-animation[data-layout="horizontal"]
            .terminal-animation-creature {
                position: relative !important;
                inset: auto !important;
                display: grid !important;
                min-width: 0;
                width: 100%;
                max-width: 12rem;
                height: 8.5rem;
                margin: 0 auto !important;
                place-items: end center;
                overflow: hidden;
                transform: none !important;
            }

            .terminal-animation[data-layout="horizontal"]
            .terminal-animation-creature::after {
                content: "";
                position: absolute;
                left: 8%;
                right: 8%;
                bottom: 0.45rem;
                width: auto;
                height: 1px;
                background:
                    linear-gradient(
                        90deg,
                        transparent,
                        rgba(192, 214, 116, 0.42),
                        transparent
                    );
                box-shadow:
                    0 0 0.4rem
                    rgba(192, 214, 116, 0.12);
            }

            .terminal-animation[data-layout="horizontal"]
            .terminal-animation-creature-image {
                position: absolute !important;
                left: 50% !important;
                right: auto !important;
                top: auto !important;
                bottom: 0.55rem !important;
                display: block !important;
                width: min(100%, 11rem) !important;
                height: 7.7rem !important;
                max-width: 11rem !important;
                max-height: 7.7rem !important;
                object-fit: contain !important;
                object-position: center bottom !important;
                image-rendering: pixelated;
                image-rendering: crisp-edges;
                transform:
                    translate3d(-50%, 0, 0) !important;
                backface-visibility: hidden;
                user-select: none;
                pointer-events: none;
            }

            .terminal-animation-creature[data-asset-state="missing"]
            .terminal-animation-creature-image {
                display: none !important;
            }

            .terminal-animation-creature-label {
                position: absolute;
                inset: auto 0 0;
                z-index: 2;
                display: none;
                width: 100%;
                margin: 0;
                color: rgba(216, 230, 219, 0.56);
                font-size: 0.62rem;
                letter-spacing: 0.05em;
                line-height: 1.2;
                text-align: center;
            }

            .terminal-animation[data-show-labels="true"]
            .terminal-animation-creature-label,
            .terminal-animation-creature[data-asset-state="missing"]
            .terminal-animation-creature-label {
                display: block;
            }

            .terminal-animation[data-layout="circular"]
            .terminal-animation-creatures {
                display: block !important;
                width: var(--terminal-animation-orbit-size);
                height: var(--terminal-animation-orbit-size);
                max-width: 28rem;
                max-height: 28rem;
                aspect-ratio: 1;
                overflow: visible;
                border:
                    1px solid
                    rgba(192, 214, 116, 0.12);
                border-radius: 50%;
                background:
                    radial-gradient(
                        circle,
                        rgba(192, 214, 116, 0.06),
                        rgba(192, 214, 116, 0.015) 52%,
                        transparent 72%
                    );
                animation:
                    speciedex-terminal-animation-orbit
                    var(--terminal-animation-rotation)
                    linear infinite;
            }

            .terminal-animation[data-layout="circular"]
            .terminal-animation-creatures::before {
                content: "";
                position: absolute;
                inset: 22%;
                border:
                    1px solid
                    rgba(192, 214, 116, 0.1);
                border-radius: 50%;
                background:
                    radial-gradient(
                        circle at 35% 30%,
                        rgba(192, 214, 116, 0.12),
                        rgba(4, 10, 6, 0.72) 62%,
                        rgba(4, 10, 6, 0.95)
                    );
                box-shadow:
                    inset 0 0 1.2rem
                    rgba(192, 214, 116, 0.08),
                    0 0 1.2rem
                    rgba(192, 214, 116, 0.08);
            }

            .terminal-animation[data-layout="circular"]
            .terminal-animation-creature {
                position: absolute !important;
                left: 50% !important;
                top: 50% !important;
                right: auto !important;
                bottom: auto !important;
                display: block !important;
                width: clamp(5rem, 18vw, 8rem);
                height: clamp(5rem, 18vw, 8rem);
                margin: 0 !important;
                overflow: visible;
                transform:
                    translate(-50%, -50%)
                    rotate(var(--terminal-animation-angle))
                    translateY(
                        calc(
                            var(--terminal-animation-radius) * -1
                        )
                    )
                    rotate(
                        calc(
                            var(--terminal-animation-angle) * -1
                        )
                    ) !important;
                transform-origin: center;
            }

            .terminal-animation[data-layout="circular"]
            .terminal-animation-creature::after,
            .terminal-animation[data-layout="circular"]
            .terminal-animation-creature-label {
                display: none !important;
            }

            .terminal-animation[data-layout="circular"]
            .terminal-animation-creature-image {
                position: absolute !important;
                left: 50% !important;
                top: 50% !important;
                right: auto !important;
                bottom: auto !important;
                display: block !important;
                width: 100% !important;
                height: 100% !important;
                max-width: none !important;
                max-height: none !important;
                object-fit: contain !important;
                object-position: center !important;
                image-rendering: pixelated;
                image-rendering: crisp-edges;
                transform:
                    translate3d(-50%, -50%, 0) !important;
                animation:
                    speciedex-terminal-animation-counter-orbit
                    var(--terminal-animation-rotation)
                    linear infinite;
                transform-origin: center;
                user-select: none;
                pointer-events: none;
            }

            .terminal-animation-message {
                width: 100%;
                margin: 0;
                color: var(--terminal-animation-color);
                font-family:
                    "IBM Plex Mono",
                    ui-monospace,
                    SFMono-Regular,
                    Consolas,
                    monospace;
                font-size:
                    clamp(
                        0.85rem,
                        2.1vw,
                        1.08rem
                    );
                letter-spacing: 0.045em;
                line-height: 1.5;
                text-align: center;
                text-shadow:
                    0 0 0.28rem
                    rgba(192, 214, 116, 0.2);
            }

            .terminal-animation-message-dots {
                display: inline-block;
                min-width: 2.2em;
                text-align: left;
            }

            .terminal-animation-message-dots::after {
                content: "";
                animation:
                    speciedex-terminal-animation-text-dots
                    1.35s steps(4, end) infinite;
            }

            .terminal-animation[data-compact="true"] {
                gap: 0.45rem;
                padding: 0.4rem 0;
            }

            .terminal-animation[data-compact="true"]
            .terminal-animation-ring-wrap {
                width: 4rem;
                height: 4rem;
                min-width: 4rem;
                min-height: 4rem;
            }

            .terminal-animation[data-compact="true"]
            .terminal-animation-creature {
                height: 5.5rem;
            }

            .terminal-animation[data-compact="true"]
            .terminal-animation-creature-image {
                height: 5rem !important;
                max-height: 5rem !important;
            }

            @keyframes speciedex-terminal-animation-dot {
                0%,
                18%,
                100% {
                    opacity: 0.16;
                    transform: scale(0.7);
                }

                42% {
                    opacity: 1;
                    transform: scale(1);
                }
            }

            @keyframes speciedex-terminal-animation-text-dots {
                0% {
                    content: "";
                }

                25% {
                    content: ".";
                }

                50% {
                    content: "..";
                }

                75%,
                100% {
                    content: "...";
                }
            }

            @keyframes speciedex-terminal-animation-orbit {
                to {
                    transform: rotate(360deg);
                }
            }

            @keyframes speciedex-terminal-animation-counter-orbit {
                to {
                    transform:
                        translate3d(-50%, -50%, 0)
                        rotate(-360deg);
                }
            }

            @media (max-width: 760px) {
                .terminal-animation {
                    padding-inline: 0.25rem;
                }

                .terminal-animation[data-layout="horizontal"]
                .terminal-animation-creatures {
                    grid-template-columns:
                        repeat(
                            var(--terminal-animation-count),
                            minmax(6.5rem, 1fr)
                        ) !important;
                    justify-content: start;
                }

                .terminal-animation[data-layout="horizontal"]
                .terminal-animation-creature {
                    min-width: 6.5rem;
                    height: 6.8rem;
                }

                .terminal-animation[data-layout="horizontal"]
                .terminal-animation-creature-image {
                    height: 6rem !important;
                    max-height: 6rem !important;
                }

                .terminal-animation[data-layout="circular"]
                .terminal-animation-creatures {
                    --terminal-animation-orbit-size:
                        min(84vw, 24rem);
                }
            }

            @media (prefers-reduced-motion: reduce) {
                .terminal-animation-dot,
                .terminal-animation-message-dots::after,
                .terminal-animation[data-layout="circular"]
                .terminal-animation-creatures,
                .terminal-animation[data-layout="circular"]
                .terminal-animation-creature-image {
                    animation-duration: 5s;
                }
            }
        `;

        (
            document.head ||
            document.documentElement
        ).appendChild(
            style
        );

        return true;
    }

    class TerminalAnimation
        extends EventTarget {
        constructor(
            target,
            options =
                {}
        ) {
            super();

            if (
                !target ||
                typeof target.appendChild !==
                    "function"
            ) {
                throw new TypeError(
                    "Terminal animation target must be a DOM element."
                );
            }

            this.target =
                target;

            this.options = {
                ...DEFAULT_OPTIONS,
                ...options,

                assetRoot:
                    String(
                        options.assetRoot ||
                        DEFAULT_OPTIONS.assetRoot
                    ),

                ring:
                    String(
                        options.ring ||
                        DEFAULT_OPTIONS.ring
                    ),

                creatureSet:
                    normalizeName(
                        options.creatureSet ||
                        options.set ||
                        DEFAULT_OPTIONS.creatureSet,
                        DEFAULT_OPTIONS.creatureSet
                    ),

                layout:
                    normalizeLayout(
                        options.layout ||
                        DEFAULT_OPTIONS.layout
                    ),

                message:
                    String(
                        options.message ||
                        DEFAULT_OPTIONS.message
                    ),

                showRing:
                    parseBoolean(
                        options.showRing,
                        DEFAULT_OPTIONS.showRing
                    ),

                showDots:
                    parseBoolean(
                        options.showDots,
                        DEFAULT_OPTIONS.showDots
                    ),

                showMessage:
                    parseBoolean(
                        options.showMessage,
                        DEFAULT_OPTIONS.showMessage
                    ),

                showCreatureLabels:
                    parseBoolean(
                        options.showCreatureLabels,
                        DEFAULT_OPTIONS.showCreatureLabels
                    ),

                creatureCount:
                    finiteNumber(
                        options.creatureCount,
                        DEFAULT_OPTIONS.creatureCount,
                        1,
                        64
                    ),

                rotateDuration:
                    finiteNumber(
                        options.rotateDuration,
                        DEFAULT_OPTIONS.rotateDuration,
                        2,
                        120
                    ),

                compact:
                    parseBoolean(
                        options.compact,
                        DEFAULT_OPTIONS.compact
                    ),

                injectStyles:
                    parseBoolean(
                        options.injectStyles,
                        DEFAULT_OPTIONS.injectStyles
                    ),

                reducedMotion:
                    parseBoolean(
                        options.reducedMotion,
                        DEFAULT_OPTIONS.reducedMotion
                    ) ||
                    prefersReducedMotion(),

                hidden:
                    parseBoolean(
                        options.hidden,
                        DEFAULT_OPTIONS.hidden
                    )
            };

            this.creatureSets =
                mergeCreatureSets(
                    options.creatureSets ||
                    options.sets
                );

            this.activeSet =
                null;

            this.destroyed =
                false;

            this.visible =
                !this.options.hidden;

            this.progress =
                null;

            this.element =
                null;

            this.elements =
                {};

            this.watchers =
                new Set();

            if (
                this.options.injectStyles
            ) {
                injectAnimationStyles();
            }

            this.build();

            this.setCreatureSet(
                this.options.creatureSet
            );

            if (
                this.options.hidden
            ) {
                this.hide();
            }
        }

        emit(
            type,
            detail =
                {}
        ) {
            const payload = {
                type,
                timestamp:
                    new Date().
                        toISOString(),
                detail:
                    safeClone(
                        detail
                    ),
                status:
                    this.status()
            };

            safeDispatch(
                this,
                type,
                payload
            );

            for (
                const watcher of
                Array.from(
                    this.watchers
                )
            ) {
                try {
                    watcher(
                        payload,
                        this
                    );
                } catch (_error) {
                    /* Watcher failures are isolated. */
                }
            }

            safeDispatch(
                this.target,
                `speciedex:terminal-animation-${type}`,
                payload,
                {
                    bubbles:
                        true
                }
            );

            safeDispatch(
                document,
                `speciedex:terminal-animation-${type}`,
                payload
            );

            return true;
        }

        watch(
            callback,
            options =
                {}
        ) {
            if (
                typeof callback !==
                    "function"
            ) {
                throw new TypeError(
                    "Animation watcher must be a function."
                );
            }

            this.watchers.add(
                callback
            );

            if (
                options.immediate ===
                    true
            ) {
                callback(
                    {
                        type:
                            "initial",

                        timestamp:
                            new Date().
                                toISOString(),

                        detail:
                            {},

                        status:
                            this.status()
                    },
                    this
                );
            }

            return () =>
                this.watchers.delete(
                    callback
                );
        }

        build() {
            const wrapper =
                document.createElement(
                    "div"
                );

            wrapper.className =
                "terminal-animation";

            wrapper.dataset.terminalAnimation =
                "";

            wrapper.dataset.layout =
                this.options.layout;

            wrapper.dataset.compact =
                String(
                    this.options.compact
                );

            wrapper.dataset.showLabels =
                String(
                    this.options.showCreatureLabels
                );

            wrapper.style.setProperty(
                "--terminal-animation-rotation",
                `${this.options.rotateDuration}s`
            );

            wrapper.setAttribute(
                "role",
                this.options.role ||
                "status"
            );

            wrapper.setAttribute(
                "aria-live",
                this.options.ariaLive ||
                "polite"
            );

            wrapper.setAttribute(
                "aria-atomic",
                "true"
            );

            const ringWrap =
                document.createElement(
                    "div"
                );

            ringWrap.className =
                "terminal-animation-ring-wrap";

            ringWrap.dataset.assetState =
                "loading";

            ringWrap.hidden =
                !this.options.showRing;

            const ring =
                document.createElement(
                    "img"
                );

            ring.className =
                "terminal-animation-ring";

            ring.alt =
                "";

            ring.decoding =
                "async";

            ring.loading =
                "eager";

            ring.setAttribute(
                "aria-hidden",
                "true"
            );

            ring.src =
                joinAsset(
                    this.options.assetRoot,
                    this.options.ring
                );

            ring.addEventListener(
                "load",
                () => {
                    ringWrap.dataset.assetState =
                        "ready";
                }
            );

            ring.addEventListener(
                "error",
                () => {
                    ringWrap.dataset.assetState =
                        "missing";

                    this.emit(
                        "asset-error",
                        {
                            type:
                                "ring",

                            source:
                                ring.src
                        }
                    );
                },
                {
                    once:
                        true
                }
            );

            const ringFallback =
                document.createElement(
                    "span"
                );

            ringFallback.className =
                "terminal-animation-ring-fallback";

            ringFallback.textContent =
                "Loading";

            ringWrap.append(
                ring,
                ringFallback
            );

            const dots =
                document.createElement(
                    "div"
                );

            dots.className =
                "terminal-animation-dots";

            dots.hidden =
                !this.options.showDots;

            dots.setAttribute(
                "aria-hidden",
                "true"
            );

            for (
                let index = 0;
                index < 3;
                index += 1
            ) {
                const dot =
                    document.createElement(
                        "span"
                    );

                dot.className =
                    "terminal-animation-dot";

                dots.appendChild(
                    dot
                );
            }

            const creatures =
                document.createElement(
                    "div"
                );

            creatures.className =
                "terminal-animation-creatures";

            creatures.dataset.terminalAnimationCreatures =
                "";

            const message =
                document.createElement(
                    "p"
                );

            message.className =
                "terminal-animation-message";

            message.hidden =
                !this.options.showMessage;

            const messageText =
                document.createElement(
                    "span"
                );

            messageText.dataset.terminalAnimationMessage =
                "";

            messageText.textContent =
                this.options.message;

            const messageDots =
                document.createElement(
                    "span"
                );

            messageDots.className =
                "terminal-animation-message-dots";

            messageDots.setAttribute(
                "aria-hidden",
                "true"
            );

            message.append(
                messageText,
                messageDots
            );

            wrapper.append(
                ringWrap,
                dots,
                creatures,
                message
            );

            this.target.appendChild(
                wrapper
            );

            this.element =
                wrapper;

            this.elements = {
                wrapper,
                ringWrap,
                ring,
                ringFallback,
                dots,
                creatures,
                message,
                messageText,
                messageDots
            };

            this.target[
                INSTANCE_SYMBOL
            ] =
                this;

            return wrapper;
        }

        resolveCreatureSet(
            nameOrSet
        ) {
            if (
                Array.isArray(
                    nameOrSet
                )
            ) {
                return {
                    name:
                        "custom",

                    creatures:
                        normalizeCreatureSet(
                            nameOrSet
                        )
                };
            }

            const name =
                normalizeName(
                    nameOrSet ||
                    this.options.creatureSet,
                    "runners"
                );

            const creatures =
                this.creatureSets.get(
                    name
                ) ||
                this.creatureSets.get(
                    "runners"
                ) ||
                [];

            return {
                name,
                creatures:
                    creatures.slice(
                        0,
                        this.options.creatureCount
                    )
            };
        }

        createCreatureElement(
            definition,
            index,
            total
        ) {
            const creature =
                document.createElement(
                    "figure"
                );

            creature.className =
                "terminal-animation-creature";

            creature.dataset.animationCreature =
                definition.name;

            creature.dataset.assetState =
                "loading";

            const angle =
                total > 0
                    ? (
                        360 /
                        total
                    ) *
                    index
                    : 0;

            creature.style.setProperty(
                "--terminal-animation-angle",
                `${angle}deg`
            );

            creature.style.setProperty(
                "--terminal-animation-radius",
                "clamp(6.5rem, 25vw, 10.5rem)"
            );

            const image =
                document.createElement(
                    "img"
                );

            image.className =
                "terminal-animation-creature-image";

            image.alt =
                definition.alt;

            image.decoding =
                "async";

            image.loading =
                "eager";

            image.dataset.animationCreatureImage =
                definition.name;

            image.src =
                joinAsset(
                    this.options.assetRoot,
                    definition.src
                );

            image.addEventListener(
                "load",
                () => {
                    creature.dataset.assetState =
                        "ready";
                }
            );

            image.addEventListener(
                "error",
                () => {
                    creature.dataset.assetState =
                        "missing";

                    this.emit(
                        "asset-error",
                        {
                            type:
                                "creature",

                            name:
                                definition.name,

                            source:
                                image.src
                        }
                    );
                },
                {
                    once:
                        true
                }
            );

            const label =
                document.createElement(
                    "figcaption"
                );

            label.className =
                "terminal-animation-creature-label";

            label.textContent =
                definition.label;

            creature.append(
                image,
                label
            );

            return creature;
        }

        setCreatureSet(
            nameOrSet
        ) {
            if (
                this.destroyed
            ) {
                return false;
            }

            const resolved =
                this.resolveCreatureSet(
                    nameOrSet
                );

            this.activeSet =
                resolved.name;

            this.elements.creatures.
                replaceChildren();

            this.element.style.setProperty(
                "--terminal-animation-count",
                String(
                    resolved.creatures.length ||
                    1
                )
            );

            resolved.creatures.forEach(
                (
                    creature,
                    index
                ) => {
                    this.elements.creatures.
                        appendChild(
                            this.createCreatureElement(
                                creature,
                                index,
                                resolved.creatures.length
                            )
                        );
                }
            );

            this.emit(
                "set-change",
                {
                    set:
                        this.activeSet,

                    creatures:
                        resolved.creatures.length
                }
            );

            return this.activeSet;
        }

        registerCreatureSet(
            name,
            creatures,
            options =
                {}
        ) {
            const normalizedName =
                normalizeName(
                    name,
                    "set"
                );

            const normalizedCreatures =
                normalizeCreatureSet(
                    creatures
                );

            if (
                !normalizedCreatures.length
            ) {
                throw new Error(
                    `Creature set "${normalizedName}" must contain at least one creature.`
                );
            }

            if (
                this.creatureSets.has(
                    normalizedName
                ) &&
                options.replace !==
                    true
            ) {
                throw new Error(
                    `Creature set already exists: ${normalizedName}`
                );
            }

            this.creatureSets.set(
                normalizedName,
                normalizedCreatures
            );

            this.emit(
                "set-register",
                {
                    set:
                        normalizedName,

                    creatures:
                        normalizedCreatures.length
                }
            );

            if (
                options.activate ===
                    true
            ) {
                this.setCreatureSet(
                    normalizedName
                );
            }

            return normalizedName;
        }

        removeCreatureSet(
            name
        ) {
            const normalizedName =
                normalizeName(
                    name,
                    "set"
                );

            if (
                normalizedName ===
                    "runners"
            ) {
                return false;
            }

            const removed =
                this.creatureSets.delete(
                    normalizedName
                );

            if (
                removed &&
                this.activeSet ===
                    normalizedName
            ) {
                this.setCreatureSet(
                    "runners"
                );
            }

            if (removed) {
                this.emit(
                    "set-remove",
                    {
                        set:
                            normalizedName
                    }
                );
            }

            return removed;
        }

        setLayout(
            layout
        ) {
            if (
                this.destroyed
            ) {
                return false;
            }

            const normalized =
                normalizeLayout(
                    layout
                );

            this.options.layout =
                normalized;

            this.element.dataset.layout =
                normalized;

            this.setCreatureSet(
                this.activeSet ||
                this.options.creatureSet
            );

            this.emit(
                "layout-change",
                {
                    layout:
                        normalized
                }
            );

            return normalized;
        }

        setMessage(
            message
        ) {
            if (
                this.destroyed
            ) {
                return false;
            }

            const value =
                String(
                    message ||
                    ""
                );

            this.options.message =
                value;

            this.elements.messageText.textContent =
                value;

            this.emit(
                "message-change",
                {
                    message:
                        value
                }
            );

            return value;
        }

        setProgress(
            value,
            label =
                null
        ) {
            if (
                this.destroyed
            ) {
                return null;
            }

            const numeric =
                Number(
                    value
                );

            this.progress =
                Number.isFinite(
                    numeric
                )
                    ? Math.min(
                        100,
                        Math.max(
                            0,
                            numeric
                        )
                    )
                    : null;

            if (
                label !==
                    null
            ) {
                this.setMessage(
                    label
                );
            }

            this.element.dataset.progress =
                this.progress ===
                    null
                    ? ""
                    : String(
                        this.progress
                    );

            this.emit(
                "progress",
                {
                    progress:
                        this.progress,

                    message:
                        this.options.message
                }
            );

            return this.progress;
        }

        setRing(
            source
        ) {
            const value =
                String(
                    source ||
                    ""
                ).trim();

            if (!value) {
                throw new Error(
                    "Animation ring source is required."
                );
            }

            this.options.ring =
                value;

            this.elements.ringWrap.dataset.assetState =
                "loading";

            this.elements.ring.src =
                joinAsset(
                    this.options.assetRoot,
                    value
                );

            return this.elements.ring.src;
        }

        setAssetRoot(
            root
        ) {
            const value =
                String(
                    root ||
                    ""
                ).trim();

            if (!value) {
                throw new Error(
                    "Animation asset root is required."
                );
            }

            this.options.assetRoot =
                value.endsWith(
                    "/"
                )
                    ? value
                    : `${value}/`;

            this.setRing(
                this.options.ring
            );

            this.setCreatureSet(
                this.activeSet ||
                this.options.creatureSet
            );

            return this.options.assetRoot;
        }

        setVisibilityOptions(
            options =
                {}
        ) {
            if (
                options.showRing !==
                    undefined
            ) {
                this.options.showRing =
                    parseBoolean(
                        options.showRing,
                        this.options.showRing
                    );

                this.elements.ringWrap.hidden =
                    !this.options.showRing;
            }

            if (
                options.showDots !==
                    undefined
            ) {
                this.options.showDots =
                    parseBoolean(
                        options.showDots,
                        this.options.showDots
                    );

                this.elements.dots.hidden =
                    !this.options.showDots;
            }

            if (
                options.showMessage !==
                    undefined
            ) {
                this.options.showMessage =
                    parseBoolean(
                        options.showMessage,
                        this.options.showMessage
                    );

                this.elements.message.hidden =
                    !this.options.showMessage;
            }

            if (
                options.showCreatureLabels !==
                    undefined
            ) {
                this.options.showCreatureLabels =
                    parseBoolean(
                        options.showCreatureLabels,
                        this.options.showCreatureLabels
                    );

                this.element.dataset.showLabels =
                    String(
                        this.options.showCreatureLabels
                    );
            }

            return {
                showRing:
                    this.options.showRing,

                showDots:
                    this.options.showDots,

                showMessage:
                    this.options.showMessage,

                showCreatureLabels:
                    this.options.showCreatureLabels
            };
        }

        show() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.visible =
                true;

            this.element.hidden =
                false;

            this.emit(
                "show",
                {}
            );

            return true;
        }

        hide() {
            if (
                this.destroyed
            ) {
                return false;
            }

            this.visible =
                false;

            this.element.hidden =
                true;

            this.emit(
                "hide",
                {}
            );

            return true;
        }

        toggle(
            visible =
                !this.visible
        ) {
            return visible
                ? this.show()
                : this.hide();
        }

        status() {
            return {
                version:
                    VERSION,

                ready:
                    !this.destroyed,

                visible:
                    this.visible,

                layout:
                    this.options.layout,

                activeSet:
                    this.activeSet,

                creatureCount:
                    this.elements.creatures?.
                        children?.
                        length ||
                    0,

                creatureSets:
                    [
                        ...this.creatureSets.
                            keys()
                    ],

                message:
                    this.options.message,

                progress:
                    this.progress,

                assetRoot:
                    this.options.assetRoot,

                ring:
                    joinAsset(
                        this.options.assetRoot,
                        this.options.ring
                    ),

                reducedMotion:
                    this.options.reducedMotion,

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

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );

            this.watchers.clear();

            if (
                this.target?.[
                    INSTANCE_SYMBOL
                ] ===
                    this
            ) {
                delete this.target[
                    INSTANCE_SYMBOL
                ];
            }

            this.element?.
                remove();

            this.elements =
                {};

            this.element =
                null;

            this.visible =
                false;

            this.destroyed =
                true;

            return true;
        }
    }

    class TerminalAnimationService
        extends EventTarget {
        constructor(
            context =
                {},
            options =
                {}
        ) {
            super();

            this.context =
                isObject(
                    context
                )
                    ? context
                    : {};

            this.options = {
                ...DEFAULT_OPTIONS,
                ...options
            };

            this.instances =
                new Set();

            this.destroyed =
                false;
        }

        create(
            target,
            options =
                {}
        ) {
            if (
                this.destroyed
            ) {
                throw new Error(
                    "Terminal animation service has been destroyed."
                );
            }

            const existing =
                target?.[
                    INSTANCE_SYMBOL
                ];

            if (
                existing instanceof
                    TerminalAnimation &&
                !existing.destroyed
            ) {
                return existing;
            }

            const instance =
                new TerminalAnimation(
                    target,
                    {
                        ...this.options,
                        ...options
                    }
                );

            this.instances.add(
                instance
            );

            instance.addEventListener(
                "destroy",
                () => {
                    this.instances.delete(
                        instance
                    );
                },
                {
                    once:
                        true
                }
            );

            return instance;
        }

        mount(
            target,
            options =
                {}
        ) {
            return this.create(
                target,
                options
            );
        }

        get(
            target
        ) {
            const instance =
                target?.[
                    INSTANCE_SYMBOL
                ];

            return (
                instance instanceof
                    TerminalAnimation &&
                !instance.destroyed
            )
                ? instance
                : null;
        }

        destroyInstance(
            target
        ) {
            return this.get(
                target
            )?.destroy?.() ||
            false;
        }

        registerCreatureSet(
            name,
            creatures,
            options =
                {}
        ) {
            for (
                const instance of
                this.instances
            ) {
                instance.registerCreatureSet(
                    name,
                    creatures,
                    options
                );
            }

            return true;
        }

        status() {
            return {
                version:
                    VERSION,

                ready:
                    !this.destroyed,

                instances:
                    this.instances.size,

                instanceStatus:
                    [
                        ...this.instances
                    ].map(
                        instance =>
                            instance.status()
                    ),

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
                [
                    ...this.instances
                ]
            ) {
                instance.destroy();
            }

            this.instances.clear();

            if (
                this.context.root?.[
                    SERVICE_SYMBOL
                ] ===
                    this
            ) {
                delete this.context.root[
                    SERVICE_SYMBOL
                ];
            }

            if (
                this.context.animation ===
                    this
            ) {
                delete this.context.animation;
            }

            this.destroyed =
                true;

            return true;
        }
    }

    function resolveTarget(
        context =
            {},
        options =
            {}
    ) {
        if (
            options.target &&
            typeof options.target.appendChild ===
                "function"
        ) {
            return options.target;
        }

        if (
            context.target &&
            typeof context.target.appendChild ===
                "function"
        ) {
            return context.target;
        }

        if (
            context.elements?.
                loading &&
            typeof context.elements.loading.appendChild ===
                "function"
        ) {
            return context.elements.loading;
        }

        if (
            context.root?.
                querySelector
        ) {
            const explicit =
                context.root.querySelector(
                    "[data-terminal-animation-host], " +
                    "[data-terminal-loading-stage]"
                );

            if (explicit) {
                return explicit;
            }
        }

        return null;
    }

    function initialize(
        context =
            {}
    ) {
        const safeContext =
            isObject(
                context
            )
                ? context
                : {};

        const root =
            safeContext.root &&
            typeof safeContext.root.querySelector ===
                "function"
                ? safeContext.root
                : document.documentElement;

        const existing =
            safeContext.animation instanceof
                TerminalAnimationService
                ? safeContext.animation
                : root?.[
                    SERVICE_SYMBOL
                ];

        if (
            existing instanceof
                TerminalAnimationService &&
            !existing.destroyed
        ) {
            safeContext.animation =
                existing;

            return existing;
        }

        const dataset =
            root.dataset ||
            {};

        const config =
            safeContext.config?.
                animation ||
            {};

        const service =
            new TerminalAnimationService(
                {
                    ...safeContext,
                    root
                },
                {
                    assetRoot:
                        dataset.terminalAnimationAssetRoot ||
                        config.assetRoot ||
                        DEFAULT_OPTIONS.assetRoot,

                    ring:
                        dataset.terminalAnimationRing ||
                        config.ring ||
                        DEFAULT_OPTIONS.ring,

                    creatureSet:
                        dataset.terminalAnimationCreatureSet ||
                        config.creatureSet ||
                        config.set ||
                        DEFAULT_OPTIONS.creatureSet,

                    creatureSets:
                        config.creatureSets ||
                        config.sets ||
                        DEFAULT_OPTIONS.creatureSets,

                    layout:
                        dataset.terminalAnimationLayout ||
                        config.layout ||
                        DEFAULT_OPTIONS.layout,

                    message:
                        dataset.terminalAnimationMessage ||
                        config.message ||
                        DEFAULT_OPTIONS.message,

                    showRing:
                        parseBoolean(
                            dataset.terminalAnimationShowRing ??
                            config.showRing,
                            DEFAULT_OPTIONS.showRing
                        ),

                    showDots:
                        parseBoolean(
                            dataset.terminalAnimationShowDots ??
                            config.showDots,
                            DEFAULT_OPTIONS.showDots
                        ),

                    showMessage:
                        parseBoolean(
                            dataset.terminalAnimationShowMessage ??
                            config.showMessage,
                            DEFAULT_OPTIONS.showMessage
                        ),

                    showCreatureLabels:
                        parseBoolean(
                            dataset.terminalAnimationShowLabels ??
                            config.showCreatureLabels,
                            DEFAULT_OPTIONS.showCreatureLabels
                        ),

                    creatureCount:
                        finiteNumber(
                            dataset.terminalAnimationCreatureCount ??
                            config.creatureCount,
                            DEFAULT_OPTIONS.creatureCount,
                            1,
                            64
                        ),

                    rotateDuration:
                        finiteNumber(
                            dataset.terminalAnimationRotateDuration ??
                            config.rotateDuration,
                            DEFAULT_OPTIONS.rotateDuration,
                            2,
                            120
                        ),

                    compact:
                        parseBoolean(
                            dataset.terminalAnimationCompact ??
                            config.compact,
                            DEFAULT_OPTIONS.compact
                        ),

                    injectStyles:
                        parseBoolean(
                            dataset.terminalAnimationInjectStyles ??
                            config.injectStyles,
                            DEFAULT_OPTIONS.injectStyles
                        ),

                    reducedMotion:
                        parseBoolean(
                            dataset.terminalAnimationReducedMotion ??
                            config.reducedMotion,
                            DEFAULT_OPTIONS.reducedMotion
                        )
                }
            );

        root[
            SERVICE_SYMBOL
        ] =
            service;

        safeContext.animation =
            service;

        safeContext.registerService?.(
            "animation",
            service
        );

        safeContext.registerRenderer?.(
            "animation",
            {
                create:
                    (
                        target,
                        options
                    ) =>
                        service.create(
                            target,
                            options
                        ),

                mount:
                    (
                        target,
                        options
                    ) =>
                        service.mount(
                            target,
                            options
                        ),

                TerminalAnimation,
                TerminalAnimationService
            }
        );

        const target =
            resolveTarget(
                safeContext,
                config
            );

        if (
            target &&
            parseBoolean(
                config.autoMount,
                false
            )
        ) {
            service.mount(
                target,
                config
            );
        }

        safeDispatch(
            document,
            "speciedex:terminal-animation-ready",
            {
                service,
                version:
                    VERSION
            }
        );

        return service;
    }

    function mount(
        target,
        options =
            {}
    ) {
        const existing =
            target?.[
                INSTANCE_SYMBOL
            ];

        if (
            existing instanceof
                TerminalAnimation &&
            !existing.destroyed
        ) {
            return existing;
        }

        return new TerminalAnimation(
            target,
            options
        );
    }

    function create(
        target,
        options =
            {}
    ) {
        return mount(
            target,
            options
        );
    }

    const api =
        Object.freeze({
            name:
                MODULE_NAME,

            version:
                VERSION,

            PRIMARY_COLOR,
            DEFAULT_ASSET_ROOT,
            INSTANCE_SYMBOL,
            SERVICE_SYMBOL,
            DEFAULT_CREATURE_SETS,
            DEFAULT_OPTIONS,

            TerminalAnimation,
            TerminalAnimationService,

            isObject,
            safeClone,
            safeDispatch,
            parseBoolean,
            finiteNumber,
            normalizeLayout,
            normalizeName,
            normalizeCreature,
            normalizeCreatureSet,
            mergeCreatureSets,
            joinAsset,
            prefersReducedMotion,
            injectAnimationStyles,
            resolveTarget,

            mount,
            create,
            initialize,
            init:
                initialize,
            setup:
                initialize
        });

    window.SpeciedexTerminalAnimation =
        api;

    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules ||
        {};

    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] =
        api;

    safeDispatch(
        document,
        "speciedex:terminal-module-available",
        {
            name:
                MODULE_NAME,

            module:
                api
        }
    );
})(window, document);
