/*
========================================================================
Speciedex.org
Terminal Loading Coordinator
========================================================================

Animated loading coordinator for SpeciedexTerminal.

Visual sequence:

    CSS progress ring
    animated HTML ellipsis
    tortoise -> rabbit -> cheetah -> dolphin
    animated HTML "Loading, please wait..." message

Animal assets:

    /static/images/terminal/loading/tortoise.gif
    /static/images/terminal/loading/rabbit.gif
    /static/images/terminal/loading/cheetah.gif
    /static/images/terminal/loading/dolphin.gif

Each GIF is expected to contain two alternating frames representing opposing
limb or body motion and must loop indefinitely.

Optional ring outline asset:

    /static/images/terminal/loading/loading-ring-outline.png

The active ring itself is rendered with CSS using #c0d674. The outline image is
decorative only and does not determine progress.

Fallback frame assets are supported when an animated GIF is unavailable:

    tortoise-1.png / tortoise-2.png
    rabbit-1.png   / rabbit-2.png
    cheetah-1.png  / cheetah-2.png
    dolphin-1.png  / dolphin-2.png

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/

(function (window, document) {
    "use strict";

    const MODULE_NAME =
        "Loading";

    const VERSION =
        "2.0.0";

    const PRIMARY_COLOR =
        "#c0d674";

    const DEFAULT_ASSET_ROOT =
        "/static/images/terminal/loading/";

    const DEFAULT_OPTIONS =
        Object.freeze({
            minimumVisibleTime:
                320,

            showDelay:
                90,

            frameInterval:
                180,

            progress:
                null,

            message:
                "Loading, please wait",

            assetRoot:
                DEFAULT_ASSET_ROOT,

            ringOutline:
                "loading-ring-outline.png",

            injectStyles:
                true,

            overlayClass:
                "terminal-loading-overlay",

            hiddenClass:
                "terminal-loading-hidden",

            activeClass:
                "terminal-is-loading",

            reducedMotion:
                false
        });

    const ANIMALS =
        Object.freeze([
            {
                name:
                    "tortoise",

                label:
                    "Tortoise",

                gif:
                    "tortoise.gif",

                frames:
                    [
                        "tortoise-1.png",
                        "tortoise-2.png"
                    ],

                duration:
                    480
            },

            {
                name:
                    "rabbit",

                label:
                    "Rabbit",

                gif:
                    "rabbit.gif",

                frames:
                    [
                        "rabbit-1.png",
                        "rabbit-2.png"
                    ],

                duration:
                    250
            },

            {
                name:
                    "cheetah",

                label:
                    "Cheetah",

                gif:
                    "cheetah.gif",

                frames:
                    [
                        "cheetah-1.png",
                        "cheetah-2.png"
                    ],

                duration:
                    140
            },

            {
                name:
                    "dolphin",

                label:
                    "Dolphin",

                gif:
                    "dolphin.gif",

                frames:
                    [
                        "dolphin-1.png",
                        "dolphin-2.png"
                    ],

                duration:
                    220
            }
        ]);

    /*
    ==========================================================================
    Utilities
    ==========================================================================
    */

    function normalizeID(value) {
        const id =
            String(
                value ?? ""
            ).trim();

        if (!id) {
            throw new Error(
                "Loading task ID is required."
            );
        }

        return id;
    }

    function normalizeLabel(
        value,
        fallback
    ) {
        const label =
            String(
                value ?? ""
            ).trim();

        return label ||
            fallback;
    }

    function clamp(
        value,
        minimum,
        maximum
    ) {
        return Math.min(
            maximum,
            Math.max(
                minimum,
                value
            )
        );
    }

    function parseProgress(value) {
        if (
            value === null ||
            value === undefined ||
            value === ""
        ) {
            return null;
        }

        const numeric =
            Number(value);

        if (!Number.isFinite(numeric)) {
            return null;
        }

        return clamp(
            numeric,
            0,
            100
        );
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

    function prefersReducedMotion() {
        return Boolean(
            window.matchMedia &&
            window.matchMedia(
                "(prefers-reduced-motion: reduce)"
            ).matches
        );
    }

    function joinAsset(
        root,
        path
    ) {
        return new URL(
            String(path),
            new URL(
                root,
                window.location.origin
            )
        ).href;
    }

    function wait(milliseconds) {
        return new Promise(
            resolve =>
                window.setTimeout(
                    resolve,
                    milliseconds
                )
        );
    }

    /*
    ==========================================================================
    Styles
    ==========================================================================
    */

    function injectLoadingStyles() {
        if (
            document.getElementById(
                "speciedex-terminal-loading-styles"
            )
        ) {
            return;
        }

        const style =
            document.createElement(
                "style"
            );

        style.id =
            "speciedex-terminal-loading-styles";

        style.textContent = `
            .terminal-loading-overlay {
                --terminal-loading-color: ${PRIMARY_COLOR};
                --terminal-loading-bg: rgba(3, 8, 5, 0.965);
                position: absolute;
                inset: 0;
                z-index: 80;
                display: grid;
                place-items: center;
                min-height: 24rem;
                padding: 1.5rem;
                overflow: hidden;
                color: var(--terminal-loading-color);
                background:
                    radial-gradient(
                        circle at 50% 18%,
                        rgba(192, 214, 116, 0.09),
                        transparent 34%
                    ),
                    var(--terminal-loading-bg);
                opacity: 1;
                visibility: visible;
                transition:
                    opacity 180ms ease,
                    visibility 180ms ease;
            }

            .terminal-loading-overlay.terminal-loading-hidden {
                opacity: 0;
                visibility: hidden;
                pointer-events: none;
            }

            .terminal-loading-stage {
                display: grid;
                width: min(100%, 72rem);
                justify-items: center;
                gap: 1rem;
                text-align: center;
            }

            .terminal-loading-ring-wrap {
                position: relative;
                width: 7.25rem;
                aspect-ratio: 1;
                display: grid;
                place-items: center;
            }

            .terminal-loading-ring-outline {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                object-fit: contain;
                opacity: 0.6;
                pointer-events: none;
            }

            .terminal-loading-ring {
                position: absolute;
                inset: 0.48rem;
                border-radius: 50%;
                background:
                    conic-gradient(
                        from 0deg,
                        var(--terminal-loading-color)
                            var(--terminal-loading-progress, 24%),
                        rgba(192, 214, 116, 0.13)
                            var(--terminal-loading-progress, 24%) 100%
                    );
                mask:
                    radial-gradient(
                        farthest-side,
                        transparent calc(100% - 0.72rem),
                        #000 calc(100% - 0.69rem)
                    );
                -webkit-mask:
                    radial-gradient(
                        farthest-side,
                        transparent calc(100% - 0.72rem),
                        #000 calc(100% - 0.69rem)
                    );
                filter:
                    drop-shadow(
                        0 0 0.7rem
                        rgba(192, 214, 116, 0.42)
                    );
                animation:
                    speciedex-terminal-loading-spin
                    1.15s linear infinite;
            }

            .terminal-loading-ring[data-determinate="true"] {
                animation:
                    speciedex-terminal-loading-ring-breathe
                    1.4s ease-in-out infinite;
            }

            .terminal-loading-ring-core {
                position: absolute;
                inset: 1.63rem;
                display: grid;
                place-items: center;
                border: 1px solid rgba(192, 214, 116, 0.22);
                border-radius: 50%;
                color: var(--terminal-loading-color);
                background: rgba(3, 8, 5, 0.78);
                font-size: 0.74rem;
                line-height: 1;
                letter-spacing: 0.04em;
            }

            .terminal-loading-ellipsis {
                display: inline-flex;
                min-height: 1.6rem;
                align-items: center;
                justify-content: center;
                gap: 0.66rem;
                margin: 0;
                color: var(--terminal-loading-color);
                font-size: 1.3rem;
                line-height: 1;
                aria-hidden: true;
            }

            .terminal-loading-dot {
                width: 0.48rem;
                aspect-ratio: 1;
                border-radius: 50%;
                background: currentColor;
                opacity: 0.18;
                transform: scale(0.72);
                animation:
                    speciedex-terminal-loading-dot
                    1.35s ease-in-out infinite;
                box-shadow:
                    0 0 0.55rem
                    rgba(192, 214, 116, 0.28);
            }

            .terminal-loading-dot:nth-child(2) {
                animation-delay: 0.22s;
            }

            .terminal-loading-dot:nth-child(3) {
                animation-delay: 0.44s;
            }

            .terminal-loading-race {
                display: grid;
                grid-template-columns:
                    repeat(4, minmax(8rem, 1fr));
                width: 100%;
                align-items: end;
                gap: clamp(1rem, 3.2vw, 3rem);
                margin-block: 0.4rem;
            }

            .terminal-loading-animal {
                position: relative;
                display: grid;
                min-width: 0;
                justify-items: center;
                align-items: end;
                gap: 0.35rem;
            }

            .terminal-loading-animal::after {
                content: "";
                display: block;
                width: 82%;
                height: 1px;
                background:
                    linear-gradient(
                        90deg,
                        transparent,
                        rgba(192, 214, 116, 0.4),
                        transparent
                    );
                box-shadow:
                    0 0 0.42rem
                    rgba(192, 214, 116, 0.15);
            }

            .terminal-loading-animal-image {
                display: block;
                width: min(100%, 10.5rem);
                height: 7.25rem;
                object-fit: contain;
                object-position: center bottom;
                image-rendering: auto;
                filter:
                    drop-shadow(
                        0 0 0.55rem
                        rgba(192, 214, 116, 0.12)
                    );
                user-select: none;
                pointer-events: none;
            }

            .terminal-loading-animal[data-asset-state="missing"]
            .terminal-loading-animal-image {
                opacity: 0;
            }

            .terminal-loading-animal-fallback {
                position: absolute;
                inset: auto 0 1.1rem;
                display: none;
                color: rgba(192, 214, 116, 0.72);
                font-size: 0.73rem;
                letter-spacing: 0.08em;
                text-transform: uppercase;
            }

            .terminal-loading-animal[data-asset-state="missing"]
            .terminal-loading-animal-fallback {
                display: block;
            }

            .terminal-loading-message {
                margin: 0.4rem 0 0;
                color: var(--terminal-loading-color);
                font-family:
                    "IBM Plex Mono",
                    ui-monospace,
                    SFMono-Regular,
                    Consolas,
                    monospace;
                font-size: clamp(0.88rem, 2.2vw, 1.15rem);
                letter-spacing: 0.05em;
                text-shadow:
                    0 0 0.65rem
                    rgba(192, 214, 116, 0.25);
            }

            .terminal-loading-message-dots {
                display: inline-block;
                width: 2.5em;
                text-align: left;
            }

            .terminal-loading-message-dots::after {
                content: "";
                animation:
                    speciedex-terminal-loading-text-dots
                    1.35s steps(4, end) infinite;
            }

            .terminal-loading-task {
                min-height: 1.2rem;
                margin: 0;
                color: rgba(216, 230, 219, 0.72);
                font-size: 0.74rem;
            }

            .terminal-loading-progress-text {
                min-height: 1.2rem;
                margin: 0;
                color: rgba(192, 214, 116, 0.7);
                font-size: 0.72rem;
            }

            @keyframes speciedex-terminal-loading-spin {
                to {
                    transform: rotate(360deg);
                }
            }

            @keyframes speciedex-terminal-loading-ring-breathe {
                0%,
                100% {
                    filter:
                        drop-shadow(
                            0 0 0.45rem
                            rgba(192, 214, 116, 0.22)
                        );
                }

                50% {
                    filter:
                        drop-shadow(
                            0 0 0.95rem
                            rgba(192, 214, 116, 0.48)
                        );
                }
            }

            @keyframes speciedex-terminal-loading-dot {
                0%,
                20%,
                100% {
                    opacity: 0.18;
                    transform: scale(0.72);
                }

                45% {
                    opacity: 1;
                    transform: scale(1);
                }
            }

            @keyframes speciedex-terminal-loading-text-dots {
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

            @media (max-width: 760px) {
                .terminal-loading-overlay {
                    min-height: 34rem;
                }

                .terminal-loading-race {
                    grid-template-columns:
                        repeat(2, minmax(7rem, 1fr));
                    gap: 1.2rem;
                }

                .terminal-loading-animal-image {
                    height: 6.5rem;
                }
            }

            @media (prefers-reduced-motion: reduce) {
                .terminal-loading-ring,
                .terminal-loading-dot,
                .terminal-loading-message-dots::after {
                    animation-duration: 3.5s;
                }
            }
        `;

        document.head.appendChild(
            style
        );
    }

    /*
    ==========================================================================
    Loading Coordinator
    ==========================================================================
    */

    class LoadingCoordinator
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
                ...options
            };

            this.options.reducedMotion =
                this.options.reducedMotion ||
                prefersReducedMotion();

            this.tasks =
                new Map();

            this.frameTimers =
                new Map();

            this.assets =
                new Map();

            this.overlay =
                null;

            this.elements =
                {};

            this.visible =
                false;

            this.showTimer =
                0;

            this.hideTimer =
                0;

            this.shownAt =
                0;

            this.destroyed =
                false;

            this.assetRoot =
                this.options.assetRoot.endsWith("/")
                    ? this.options.assetRoot
                    : `${this.options.assetRoot}/`;

            if (
                this.options.injectStyles
            ) {
                injectLoadingStyles();
            }

            this.mount();
            this.preloadAssets();
        }

        /*
        ======================================================================
        DOM Construction
        ======================================================================
        */

        mount() {
            const existing =
                this.context.root?.
                    querySelector?.(
                        "[data-terminal-loading-overlay]"
                    );

            if (existing) {
                this.overlay =
                    existing;

                this.captureElements();
                return existing;
            }

            const overlay =
                document.createElement(
                    "section"
                );

            overlay.className =
                `${this.options.overlayClass} ${this.options.hiddenClass}`;

            overlay.hidden =
                false;

            overlay.dataset.terminalLoadingOverlay =
                "";

            overlay.dataset.loadingState =
                "idle";

            overlay.setAttribute(
                "role",
                "status"
            );

            overlay.setAttribute(
                "aria-live",
                "polite"
            );

            overlay.setAttribute(
                "aria-atomic",
                "true"
            );

            const stage =
                document.createElement(
                    "div"
                );

            stage.className =
                "terminal-loading-stage";

            stage.dataset.terminalLoadingStage =
                "";

            const ringWrap =
                document.createElement(
                    "div"
                );

            ringWrap.className =
                "terminal-loading-ring-wrap";

            const ringOutline =
                document.createElement(
                    "img"
                );

            ringOutline.className =
                "terminal-loading-ring-outline";

            ringOutline.alt =
                "";

            ringOutline.setAttribute(
                "aria-hidden",
                "true"
            );

            ringOutline.dataset.terminalLoadingRingOutline =
                "";

            ringOutline.src =
                joinAsset(
                    this.assetRoot,
                    this.options.ringOutline
                );

            ringOutline.addEventListener(
                "error",
                () => {
                    ringOutline.hidden =
                        true;
                },
                {
                    once:
                        true
                }
            );

            const ring =
                document.createElement(
                    "div"
                );

            ring.className =
                "terminal-loading-ring";

            ring.dataset.terminalLoadingRing =
                "";

            ring.dataset.determinate =
                "false";

            const ringCore =
                document.createElement(
                    "span"
                );

            ringCore.className =
                "terminal-loading-ring-core";

            ringCore.dataset.terminalLoadingRingValue =
                "";

            ringCore.textContent =
                "•••";

            ringWrap.append(
                ringOutline,
                ring,
                ringCore
            );

            const ellipsis =
                document.createElement(
                    "div"
                );

            ellipsis.className =
                "terminal-loading-ellipsis";

            ellipsis.dataset.terminalLoadingEllipsis =
                "";

            ellipsis.setAttribute(
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
                    "terminal-loading-dot";

                ellipsis.appendChild(
                    dot
                );
            }

            const race =
                document.createElement(
                    "div"
                );

            race.className =
                "terminal-loading-race";

            race.dataset.terminalLoadingRace =
                "";

            for (const animal of ANIMALS) {
                race.appendChild(
                    this.createAnimal(
                        animal
                    )
                );
            }

            const message =
                document.createElement(
                    "p"
                );

            message.className =
                "terminal-loading-message";

            message.dataset.terminalLoadingMessage =
                "";

            const messageText =
                document.createElement(
                    "span"
                );

            messageText.dataset.terminalLoadingMessageText =
                "";

            messageText.textContent =
                this.options.message;

            const messageDots =
                document.createElement(
                    "span"
                );

            messageDots.className =
                "terminal-loading-message-dots";

            messageDots.setAttribute(
                "aria-hidden",
                "true"
            );

            message.append(
                messageText,
                messageDots
            );

            const task =
                document.createElement(
                    "p"
                );

            task.className =
                "terminal-loading-task";

            task.dataset.terminalLoadingTask =
                "";

            const progress =
                document.createElement(
                    "p"
                );

            progress.className =
                "terminal-loading-progress-text";

            progress.dataset.terminalLoadingProgressText =
                "";

            stage.append(
                ringWrap,
                ellipsis,
                race,
                message,
                task,
                progress
            );

            overlay.appendChild(
                stage
            );

            const host =
                this.context.elements?.
                    shell ||
                this.context.root;

            const computed =
                window.getComputedStyle(
                    host
                );

            if (
                computed.position ===
                "static"
            ) {
                host.style.position =
                    "relative";
            }

            host.appendChild(
                overlay
            );

            this.overlay =
                overlay;

            this.captureElements();

            return overlay;
        }

        createAnimal(
            definition
        ) {
            const wrapper =
                document.createElement(
                    "figure"
                );

            wrapper.className =
                "terminal-loading-animal";

            wrapper.dataset.loadingAnimal =
                definition.name;

            wrapper.dataset.assetState =
                "loading";

            const image =
                document.createElement(
                    "img"
                );

            image.className =
                "terminal-loading-animal-image";

            image.alt =
                `${definition.label} running animation`;

            image.decoding =
                "async";

            image.loading =
                "eager";

            image.dataset.loadingAnimalImage =
                definition.name;

            image.src =
                joinAsset(
                    this.assetRoot,
                    definition.gif
                );

            image.addEventListener(
                "load",
                () => {
                    wrapper.dataset.assetState =
                        "ready";
                }
            );

            image.addEventListener(
                "error",
                () => {
                    this.activateFrameFallback(
                        wrapper,
                        image,
                        definition
                    );
                },
                {
                    once:
                        true
                }
            );

            const fallback =
                document.createElement(
                    "figcaption"
                );

            fallback.className =
                "terminal-loading-animal-fallback";

            fallback.textContent =
                definition.label;

            wrapper.append(
                image,
                fallback
            );

            return wrapper;
        }

        captureElements() {
            const find =
                selector =>
                    this.overlay.querySelector(
                        selector
                    );

            this.elements.ring =
                find(
                    "[data-terminal-loading-ring]"
                );

            this.elements.ringValue =
                find(
                    "[data-terminal-loading-ring-value]"
                );

            this.elements.message =
                find(
                    "[data-terminal-loading-message-text]"
                );

            this.elements.task =
                find(
                    "[data-terminal-loading-task]"
                );

            this.elements.progressText =
                find(
                    "[data-terminal-loading-progress-text]"
                );
        }

        /*
        ======================================================================
        Assets
        ======================================================================
        */

        async preloadImage(
            url
        ) {
            if (
                this.assets.has(
                    url
                )
            ) {
                return this.assets.get(
                    url
                );
            }

            const promise =
                new Promise(
                    (
                        resolve,
                        reject
                    ) => {
                        const image =
                            new Image();

                        image.decoding =
                            "async";

                        image.onload =
                            () =>
                                resolve(
                                    url
                                );

                        image.onerror =
                            () =>
                                reject(
                                    new Error(
                                        `Unable to load image: ${url}`
                                    )
                                );

                        image.src =
                            url;
                    }
                );

            this.assets.set(
                url,
                promise
            );

            return promise;
        }

        async preloadAssets() {
            const urls = [
                joinAsset(
                    this.assetRoot,
                    this.options.ringOutline
                )
            ];

            for (const animal of ANIMALS) {
                urls.push(
                    joinAsset(
                        this.assetRoot,
                        animal.gif
                    )
                );

                for (const frame of animal.frames) {
                    urls.push(
                        joinAsset(
                            this.assetRoot,
                            frame
                        )
                    );
                }
            }

            const results =
                await Promise.allSettled(
                    urls.map(
                        url =>
                            this.preloadImage(
                                url
                            )
                    )
                );

            this.emit(
                "assets",
                {
                    loaded:
                        results.filter(
                            result =>
                                result.status ===
                                "fulfilled"
                        ).length,

                    failed:
                        results.filter(
                            result =>
                                result.status ===
                                "rejected"
                        ).length,

                    total:
                        results.length
                }
            );

            return results;
        }

        async activateFrameFallback(
            wrapper,
            image,
            definition
        ) {
            const frameURLs =
                definition.frames.map(
                    frame =>
                        joinAsset(
                            this.assetRoot,
                            frame
                        )
                );

            const results =
                await Promise.allSettled(
                    frameURLs.map(
                        url =>
                            this.preloadImage(
                                url
                            )
                    )
                );

            const available =
                results
                    .filter(
                        result =>
                            result.status ===
                            "fulfilled"
                    )
                    .map(
                        result =>
                            result.value
                    );

            if (!available.length) {
                wrapper.dataset.assetState =
                    "missing";

                return;
            }

            wrapper.dataset.assetState =
                "fallback";

            image.src =
                available[0];

            if (
                available.length <
                    2 ||
                this.options.reducedMotion
            ) {
                return;
            }

            let index =
                0;

            const timer =
                window.setInterval(
                    () => {
                        index =
                            (
                                index +
                                1
                            ) %
                            available.length;

                        image.src =
                            available[
                                index
                            ];
                    },
                    definition.duration ||
                    this.options.frameInterval
                );

            this.frameTimers.set(
                definition.name,
                timer
            );
        }

        /*
        ======================================================================
        Task Lifecycle
        ======================================================================
        */

        begin(
            id,
            label = id,
            options = {}
        ) {
            const taskID =
                normalizeID(
                    id
                );

            const now =
                performance.now();

            const task = {
                id:
                    taskID,

                label:
                    normalizeLabel(
                        label,
                        taskID
                    ),

                startedAt:
                    now,

                progress:
                    parseProgress(
                        options.progress
                    ),

                metadata:
                    options.metadata &&
                    typeof options.metadata ===
                    "object"
                        ? {
                            ...options.metadata
                        }
                        : {},

                abortController:
                    options.abortController ||
                    null
            };

            this.tasks.set(
                taskID,
                task
            );

            this.update();

            return taskID;
        }

        setProgress(
            id,
            progress,
            label = null
        ) {
            const taskID =
                normalizeID(
                    id
                );

            const task =
                this.tasks.get(
                    taskID
                );

            if (!task) {
                throw new Error(
                    `Unknown loading task: ${taskID}`
                );
            }

            task.progress =
                parseProgress(
                    progress
                );

            if (
                label !==
                null
            ) {
                task.label =
                    normalizeLabel(
                        label,
                        task.label
                    );
            }

            this.update();

            return {
                ...task
            };
        }

        end(
            id,
            result = null
        ) {
            const taskID =
                normalizeID(
                    id
                );

            const task =
                this.tasks.get(
                    taskID
                ) ||
                null;

            if (!task) {
                return null;
            }

            this.tasks.delete(
                taskID
            );

            const completed = {
                ...task,

                endedAt:
                    performance.now(),

                elapsed:
                    performance.now() -
                    task.startedAt,

                result
            };

            this.emit(
                "task-end",
                completed
            );

            this.update();

            return completed;
        }

        fail(
            id,
            error
        ) {
            const completed =
                this.end(
                    id,
                    null
                );

            if (!completed) {
                return null;
            }

            const failed = {
                ...completed,

                error:
                    error instanceof Error
                        ? {
                            name:
                                error.name,

                            message:
                                error.message
                        }
                        : {
                            name:
                                "Error",

                            message:
                                String(error)
                        }
            };

            this.emit(
                "task-fail",
                failed
            );

            return failed;
        }

        cancel(
            id
        ) {
            const taskID =
                normalizeID(
                    id
                );

            const task =
                this.tasks.get(
                    taskID
                );

            if (!task) {
                return false;
            }

            task.abortController?.
                abort?.();

            this.tasks.delete(
                taskID
            );

            this.emit(
                "task-cancel",
                {
                    ...task,

                    cancelledAt:
                        performance.now()
                }
            );

            this.update();

            return true;
        }

        clear() {
            for (const task of this.tasks.values()) {
                task.abortController?.
                    abort?.();
            }

            this.tasks.clear();
            this.update();
        }

        /*
        ======================================================================
        Visibility
        ======================================================================
        */

        show() {
            if (
                this.visible ||
                !this.overlay
            ) {
                return;
            }

            window.clearTimeout(
                this.hideTimer
            );

            this.visible =
                true;

            this.shownAt =
                performance.now();

            this.overlay.classList.remove(
                this.options.hiddenClass
            );

            this.overlay.dataset.loadingState =
                "active";

            this.overlay.setAttribute(
                "aria-hidden",
                "false"
            );

            this.emit(
                "show",
                this.status()
            );
        }

        async hide() {
            if (
                !this.visible ||
                !this.overlay
            ) {
                return;
            }

            const elapsed =
                performance.now() -
                this.shownAt;

            const remaining =
                Math.max(
                    0,
                    this.options.minimumVisibleTime -
                    elapsed
                );

            if (remaining) {
                await wait(
                    remaining
                );
            }

            if (this.tasks.size) {
                return;
            }

            this.visible =
                false;

            this.overlay.classList.add(
                this.options.hiddenClass
            );

            this.overlay.dataset.loadingState =
                "idle";

            this.overlay.setAttribute(
                "aria-hidden",
                "true"
            );

            this.emit(
                "hide",
                this.status()
            );
        }

        /*
        ======================================================================
        Rendering
        ======================================================================
        */

        aggregateProgress() {
            const progress =
                [
                    ...this.tasks.values()
                ]
                    .map(
                        task =>
                            task.progress
                    )
                    .filter(
                        value =>
                            value !==
                            null
                    );

            if (!progress.length) {
                return null;
            }

            return progress.reduce(
                (
                    total,
                    value
                ) =>
                    total +
                    value,
                0
            ) /
            progress.length;
        }

        updateRing(
            progress
        ) {
            if (
                !this.elements.ring ||
                !this.elements.ringValue
            ) {
                return;
            }

            if (progress === null) {
                this.elements.ring.dataset.determinate =
                    "false";

                this.elements.ring.style.setProperty(
                    "--terminal-loading-progress",
                    "24%"
                );

                this.elements.ringValue.textContent =
                    "•••";

                return;
            }

            const normalized =
                clamp(
                    progress,
                    0,
                    100
                );

            this.elements.ring.dataset.determinate =
                "true";

            this.elements.ring.style.setProperty(
                "--terminal-loading-progress",
                `${normalized}%`
            );

            this.elements.ringValue.textContent =
                `${Math.round(normalized)}%`;
        }

        update() {
            const busy =
                this.tasks.size >
                0;

            this.context.root?.
                classList.toggle(
                    this.options.activeClass,
                    busy
                );

            if (busy) {
                window.clearTimeout(
                    this.showTimer
                );

                this.showTimer =
                    window.setTimeout(
                        () =>
                            this.show(),
                        this.visible
                            ? 0
                            : this.options.showDelay
                    );
            } else {
                window.clearTimeout(
                    this.showTimer
                );

                this.hide();
            }

            const tasks =
                [
                    ...this.tasks.values()
                ];

            const activeTask =
                tasks[
                    tasks.length -
                    1
                ] ||
                null;

            const progress =
                this.aggregateProgress();

            this.updateRing(
                progress
            );

            if (
                this.elements.message
            ) {
                this.elements.message.textContent =
                    this.options.message;
            }

            if (
                this.elements.task
            ) {
                this.elements.task.textContent =
                    activeTask
                        ? activeTask.label
                        : "";
            }

            if (
                this.elements.progressText
            ) {
                this.elements.progressText.textContent =
                    progress ===
                    null
                        ? busy
                            ? `${tasks.length} active task${
                                tasks.length ===
                                1
                                    ? ""
                                    : "s"
                            }`
                            : ""
                        : `${Math.round(progress)}% complete`;
            }

            this.context.setStatus?.(
                busy
                    ? `Loading (${this.tasks.size})`
                    : "Ready",
                busy
                    ? "loading"
                    : "ready"
            );

            const detail = {
                busy,
                progress,
                activeTask:
                    activeTask
                        ? {
                            ...activeTask
                        }
                        : null,
                tasks:
                    tasks.map(
                        task => ({
                            ...task
                        })
                    )
            };

            this.dispatchEvent(
                new CustomEvent(
                    "change",
                    {
                        detail
                    }
                )
            );

            this.context.events?.emit?.(
                "loading:change",
                detail
            );

            this.context.root?.
                dispatchEvent?.(
                    new CustomEvent(
                        "speciedex:terminal-loading-change",
                        {
                            bubbles:
                                true,

                            detail
                        }
                    )
                );
        }

        /*
        ======================================================================
        Diagnostics
        ======================================================================
        */

        status() {
            const tasks =
                [
                    ...this.tasks.values()
                ];

            return {
                version:
                    VERSION,

                busy:
                    tasks.length >
                    0,

                visible:
                    this.visible,

                progress:
                    this.aggregateProgress(),

                taskCount:
                    tasks.length,

                tasks:
                    tasks.map(
                        task => ({
                            id:
                                task.id,

                            label:
                                task.label,

                            progress:
                                task.progress,

                            elapsed:
                                performance.now() -
                                task.startedAt
                        })
                    ),

                assets: {
                    root:
                        this.assetRoot,

                    animals:
                        ANIMALS.map(
                            animal => ({
                                name:
                                    animal.name,

                                gif:
                                    joinAsset(
                                        this.assetRoot,
                                        animal.gif
                                    ),

                                frames:
                                    animal.frames.map(
                                        frame =>
                                            joinAsset(
                                                this.assetRoot,
                                                frame
                                            )
                                    )
                            })
                        ),

                    ringOutline:
                        joinAsset(
                            this.assetRoot,
                            this.options.ringOutline
                        )
                }
            };
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
                `loading:${type}`,
                detail
            );

            document.dispatchEvent(
                new CustomEvent(
                    `speciedex:terminal-loading-${type}`,
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

            window.clearTimeout(
                this.showTimer
            );

            window.clearTimeout(
                this.hideTimer
            );

            for (
                const timer of
                this.frameTimers.values()
            ) {
                window.clearInterval(
                    timer
                );
            }

            this.frameTimers.clear();

            this.clear();

            this.overlay?.
                remove();

            this.overlay =
                null;

            this.destroyed =
                true;

            this.emit(
                "destroy",
                {
                    version:
                        VERSION
                }
            );
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
            context.loading instanceof
            LoadingCoordinator
        ) {
            return context.loading;
        }

        const root =
            context.root;

        const loading =
            new LoadingCoordinator(
                context,
                {
                    minimumVisibleTime:
                        Number(
                            root?.
                                dataset.
                                terminalLoadingMinimumTime
                        ) ||
                        DEFAULT_OPTIONS.minimumVisibleTime,

                    showDelay:
                        Number(
                            root?.
                                dataset.
                                terminalLoadingDelay
                        ) ||
                        DEFAULT_OPTIONS.showDelay,

                    frameInterval:
                        Number(
                            root?.
                                dataset.
                                terminalLoadingFrameInterval
                        ) ||
                        DEFAULT_OPTIONS.frameInterval,

                    message:
                        root?.
                            dataset.
                            terminalLoadingMessage ||
                        DEFAULT_OPTIONS.message,

                    assetRoot:
                        root?.
                            dataset.
                            terminalLoadingAssetRoot ||
                        DEFAULT_OPTIONS.assetRoot,

                    ringOutline:
                        root?.
                            dataset.
                            terminalLoadingRingOutline ||
                        DEFAULT_OPTIONS.ringOutline,

                    injectStyles:
                        parseBoolean(
                            root?.
                                dataset.
                                terminalLoadingInjectStyles,
                            true
                        )
                }
            );

        context.loading =
            loading;

        context.registerService?.(
            "loading",
            loading
        );

        return loading;
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
                    "loading",

                category:
                    "system",

                description:
                    "Display loading coordinator status.",

                usage:
                    "loading",

                handler: ({
                    context,
                    writeJSON
                }) =>
                    writeJSON(
                        context.loading.status()
                    )
            },

            {
                name:
                    "loading-demo",

                category:
                    "system",

                description:
                    "Run the animated Speciedex loading demonstration.",

                usage:
                    "loading-demo [seconds]",

                handler: async ({
                    args,
                    context,
                    write
                }) => {
                    const seconds =
                        clamp(
                            Number(
                                args[0]
                            ) ||
                            5,
                            1,
                            60
                        );

                    const id =
                        `demo:${Date.now()}`;

                    context.loading.begin(
                        id,
                        "Demonstrating Speciedex loading animation",
                        {
                            progress:
                                0
                        }
                    );

                    const started =
                        performance.now();

                    while (
                        performance.now() -
                        started <
                        seconds *
                        1000
                    ) {
                        const elapsed =
                            performance.now() -
                            started;

                        context.loading.setProgress(
                            id,
                            clamp(
                                (
                                    elapsed /
                                    (
                                        seconds *
                                        1000
                                    )
                                ) *
                                100,
                                0,
                                100
                            )
                        );

                        await wait(
                            80
                        );
                    }

                    context.loading.setProgress(
                        id,
                        100
                    );

                    await wait(
                        180
                    );

                    context.loading.end(
                        id
                    );

                    return write(
                        "Loading demonstration complete.",
                        "success"
                    );
                }
            },

            {
                name:
                    "loading-begin",

                category:
                    "system",

                description:
                    "Begin a named loading task.",

                usage:
                    "loading-begin <id> [label]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const id =
                        args.shift();

                    if (!id) {
                        throw new Error(
                            "A loading task ID is required."
                        );
                    }

                    context.loading.begin(
                        id,
                        args.join(
                            " "
                        ) ||
                        id
                    );

                    return write(
                        `Loading task started: ${id}`,
                        "success"
                    );
                }
            },

            {
                name:
                    "loading-progress",

                category:
                    "system",

                description:
                    "Set progress for a named loading task.",

                usage:
                    "loading-progress <id> <0-100> [label]",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const id =
                        args.shift();

                    const progress =
                        args.shift();

                    if (
                        !id ||
                        progress ===
                        undefined
                    ) {
                        throw new Error(
                            "Usage: loading-progress <id> <0-100> [label]"
                        );
                    }

                    context.loading.setProgress(
                        id,
                        progress,
                        args.join(
                            " "
                        ) ||
                        null
                    );

                    return write(
                        `Loading task ${id}: ${parseProgress(progress)}%`,
                        "success"
                    );
                }
            },

            {
                name:
                    "loading-end",

                category:
                    "system",

                description:
                    "Complete a named loading task.",

                usage:
                    "loading-end <id>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const id =
                        args[0];

                    if (!id) {
                        throw new Error(
                            "A loading task ID is required."
                        );
                    }

                    if (
                        !context.loading.end(
                            id
                        )
                    ) {
                        throw new Error(
                            `Unknown loading task: ${id}`
                        );
                    }

                    return write(
                        `Loading task completed: ${id}`,
                        "success"
                    );
                }
            },

            {
                name:
                    "loading-cancel",

                category:
                    "system",

                description:
                    "Cancel a named loading task.",

                usage:
                    "loading-cancel <id>",

                handler: ({
                    args,
                    context,
                    write
                }) => {
                    const id =
                        args[0];

                    if (!id) {
                        throw new Error(
                            "A loading task ID is required."
                        );
                    }

                    if (
                        !context.loading.cancel(
                            id
                        )
                    ) {
                        throw new Error(
                            `Unknown loading task: ${id}`
                        );
                    }

                    return write(
                        `Loading task cancelled: ${id}`,
                        "warning"
                    );
                }
            },

            {
                name:
                    "loading-clear",

                category:
                    "system",

                description:
                    "Cancel and clear every active loading task.",

                usage:
                    "loading-clear",

                handler: ({
                    context,
                    write
                }) => {
                    context.loading.clear();

                    return write(
                        "All loading tasks cleared.",
                        "success"
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

            PRIMARY_COLOR,
            DEFAULT_ASSET_ROOT,
            DEFAULT_OPTIONS,
            ANIMALS,
            LoadingCoordinator,

            normalizeID,
            normalizeLabel,
            parseProgress,
            parseBoolean,
            injectLoadingStyles,
            joinAsset,

            initialize,
            mount:
                initialize,
            init:
                initialize,
            setup:
                initialize,

            commands
        });

    window.SpeciedexTerminalLoading =
        api;

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
