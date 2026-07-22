/*
========================================================================
Speciedex.org
Terminal CMatrix Visualization Adapter
========================================================================

Wraps the external CMatrix runtime and exposes a stable SpeciedexTerminal
visualization API. A lightweight canvas fallback is provided only when the
external CMatrix implementation is unavailable.

Copyright (c) 2026 Speciedex.org & ZZX-Labs R&D
Licensed under the MIT License.
========================================================================
*/
(function (window, document) {
    "use strict";

    const MODULE_NAME = "CMatrix";
    const DEFAULT_GLYPHS =
        "0123456789abcdefABCDEF.:;+-*/=<>[]{}()ACGTN";

    function isCanvas(value) {
        return value instanceof HTMLCanvasElement;
    }

    function resolveCanvas(target) {
        if (isCanvas(target)) {
            return target;
        }

        if (target instanceof Element) {
            return (
                target.querySelector("canvas") ||
                target.appendChild(document.createElement("canvas"))
            );
        }

        throw new TypeError("CMatrix requires a canvas or container element.");
    }

    function createResizeObserver(canvas, resize) {
        if ("ResizeObserver" in window) {
            const observer = new ResizeObserver(resize);
            observer.observe(canvas);
            return () => observer.disconnect();
        }

        window.addEventListener("resize", resize);
        return () => window.removeEventListener("resize", resize);
    }

    function findExternalConstructor() {
        const candidates = [
            window.CMatrix,
            window.cmatrix,
            window.CMatrixRenderer,
            window.CMatrixEngine
        ];

        return candidates.find(candidate =>
            typeof candidate === "function" ||
            (candidate && typeof candidate === "object")
        ) || null;
    }

    class FallbackMatrix {
        constructor(canvas, options = {}) {
            this.canvas = canvas;
            this.context = canvas.getContext("2d", {
                alpha: true,
                desynchronized: true
            });
            this.options = {
                glyphs: options.glyphs || DEFAULT_GLYPHS,
                fontSize: Number(options.fontSize) || 14,
                speed: Number(options.speed) || 1,
                density: Number(options.density) || 0.82,
                trail: Number(options.trail) || 0.12,
                opacity: Number(options.opacity) || 0.34
            };
            this.columns = [];
            this.frame = 0;
            this.running = false;
            this.destroyed = false;
            this.animationFrame = 0;
            this.cleanupResize = createResizeObserver(
                canvas,
                () => this.resize()
            );
            this.resize();
        }

        resize() {
            const rect = this.canvas.getBoundingClientRect();
            const ratio = Math.min(window.devicePixelRatio || 1, 2);

            this.canvas.width = Math.max(1, Math.floor(rect.width * ratio));
            this.canvas.height = Math.max(1, Math.floor(rect.height * ratio));
            this.context.setTransform(ratio, 0, 0, ratio, 0, 0);

            const width = Math.max(1, rect.width);
            const count = Math.max(
                1,
                Math.ceil(width / this.options.fontSize)
            );

            this.columns = Array.from({ length: count }, (_, index) => ({
                x: index * this.options.fontSize,
                y: Math.random() * Math.max(1, rect.height),
                speed:
                    (0.3 + Math.random() * 1.2) *
                    this.options.speed,
                alpha:
                    0.08 +
                    Math.random() *
                    this.options.opacity
            }));
        }

        draw() {
            if (!this.running || this.destroyed) {
                return;
            }

            const width = this.canvas.clientWidth;
            const height = this.canvas.clientHeight;

            this.context.fillStyle =
                `rgba(2, 10, 5, ${this.options.trail})`;
            this.context.fillRect(0, 0, width, height);

            this.context.font =
                `${this.options.fontSize}px monospace`;
            this.context.textBaseline = "top";

            for (const column of this.columns) {
                if (Math.random() > this.options.density) {
                    continue;
                }

                const glyph =
                    this.options.glyphs[
                        Math.floor(
                            Math.random() *
                            this.options.glyphs.length
                        )
                    ];

                this.context.fillStyle =
                    `rgba(192, 214, 116, ${column.alpha})`;
                this.context.fillText(
                    glyph,
                    column.x,
                    column.y
                );

                column.y += column.speed * 2.2;

                if (
                    column.y > height + this.options.fontSize ||
                    Math.random() > 0.998
                ) {
                    column.y = -this.options.fontSize;
                    column.speed =
                        (0.3 + Math.random() * 1.2) *
                        this.options.speed;
                }
            }

            this.frame += 1;
            this.animationFrame =
                window.requestAnimationFrame(
                    () => this.draw()
                );
        }

        start() {
            if (this.running || this.destroyed) {
                return;
            }

            this.running = true;
            this.draw();
        }

        stop() {
            this.running = false;

            if (this.animationFrame) {
                window.cancelAnimationFrame(
                    this.animationFrame
                );
            }
        }

        update(options = {}) {
            Object.assign(this.options, options);
            this.resize();
        }

        destroy() {
            this.stop();
            this.cleanupResize?.();
            this.destroyed = true;
        }
    }

    class ExternalCMatrixAdapter {
        constructor(canvas, options = {}) {
            this.canvas = canvas;
            this.options = { ...options };
            this.instance = null;
            this.destroyed = false;
            this.external = true;
            this.mountExternal();
        }

        mountExternal() {
            const external = findExternalConstructor();

            if (!external) {
                throw new Error("External CMatrix runtime is unavailable.");
            }

            const configuration = {
                canvas: this.canvas,
                target: this.canvas,
                element: this.canvas,
                ...this.options
            };

            if (typeof external === "function") {
                try {
                    this.instance =
                        new external(this.canvas, configuration);
                } catch (firstError) {
                    try {
                        this.instance =
                            new external(configuration);
                    } catch (secondError) {
                        this.instance =
                            external(this.canvas, configuration);
                    }
                }
            } else if (typeof external.create === "function") {
                this.instance =
                    external.create(this.canvas, configuration);
            } else if (typeof external.mount === "function") {
                this.instance =
                    external.mount(this.canvas, configuration);
            } else if (typeof external.init === "function") {
                this.instance =
                    external.init(this.canvas, configuration);
            } else {
                throw new Error(
                    "Unsupported external CMatrix API."
                );
            }
        }

        call(methods, ...args) {
            for (const method of methods) {
                if (
                    this.instance &&
                    typeof this.instance[method] === "function"
                ) {
                    return this.instance[method](...args);
                }
            }

            return undefined;
        }

        start() {
            this.call(["start", "play", "resume", "run"]);
        }

        stop() {
            this.call(["stop", "pause", "suspend"]);
        }

        update(options = {}) {
            Object.assign(this.options, options);

            return this.call(
                ["update", "configure", "setOptions", "setConfig"],
                this.options
            );
        }

        destroy() {
            this.call(
                ["destroy", "dispose", "unmount", "remove"]
            );
            this.destroyed = true;
        }
    }

    class CMatrixController {
        constructor(target, options = {}) {
            this.canvas = resolveCanvas(target);
            this.options = {
                glyphs: DEFAULT_GLYPHS,
                fontSize: 14,
                speed: 1,
                density: 0.82,
                trail: 0.12,
                opacity: 0.34,
                autoStart: true,
                preferExternal: true,
                ...options
            };

            this.engine = null;
            this.external = false;
            this.createEngine();

            if (this.options.autoStart !== false) {
                this.start();
            }
        }

        createEngine() {
            if (
                this.options.preferExternal !== false &&
                findExternalConstructor()
            ) {
                try {
                    this.engine =
                        new ExternalCMatrixAdapter(
                            this.canvas,
                            this.options
                        );
                    this.external = true;
                    return;
                } catch (error) {
                    console.warn(
                        "[SpeciedexTerminalCMatrix] " +
                        "External CMatrix initialization failed; " +
                        "using fallback renderer.",
                        error
                    );
                }
            }

            this.engine =
                new FallbackMatrix(
                    this.canvas,
                    this.options
                );
        }

        start() {
            this.engine?.start?.();
            return this;
        }

        stop() {
            this.engine?.stop?.();
            return this;
        }

        update(options = {}) {
            Object.assign(this.options, options);
            this.engine?.update?.(options);
            return this;
        }

        destroy() {
            this.engine?.destroy?.();
            this.engine = null;
        }
    }

    function mount(target, options = {}) {
        return new CMatrixController(target, options);
    }

    function render(data, options = {}) {
        const container =
            document.createElement("section");
        container.className =
            "terminal-visualization terminal-visualization-cmatrix";

        const canvas =
            document.createElement("canvas");
        canvas.className =
            "terminal-cmatrix-canvas";

        container.appendChild(canvas);

        const controller =
            mount(canvas, {
                ...options,
                data
            });

        container.controller = controller;
        container.destroy = () =>
            controller.destroy();

        return container;
    }

    function initialize(context) {
        const visualization = {
            mount,
            render,
            Controller: CMatrixController,
            usingExternal:
                Boolean(findExternalConstructor())
        };

        context.registerVisualization?.(
            "cmatrix",
            visualization
        );

        context.registerRenderer?.(
            "cmatrix",
            visualization
        );

        context.cmatrix = visualization;

        return visualization;
    }

    const commands = [
        {
            name: "cmatrix",
            category: "visualization",
            description:
                "Render the CMatrix terminal visualization.",
            usage: "cmatrix [start|stop|status]",
            handler: ({
                args,
                context,
                writeJSON,
                write
            }) => {
                const action = args[0] || "status";
                const splash =
                    context.terminalSplash;

                const controller =
                    splash?.matrixController ||
                    splash?.cmatrixController;

                if (action === "start") {
                    controller?.start?.();
                    return write(
                        "CMatrix visualization started.",
                        "success"
                    );
                }

                if (action === "stop") {
                    controller?.stop?.();
                    return write(
                        "CMatrix visualization stopped.",
                        "success"
                    );
                }

                return writeJSON({
                    available: true,
                    external:
                        Boolean(findExternalConstructor()),
                    running:
                        Boolean(controller)
                });
            }
        }
    ];

    const api = Object.freeze({
        name: MODULE_NAME,
        CMatrixController,
        mount,
        render,
        initialize,
        init: initialize,
        setup: initialize,
        commands
    });

    window.SpeciedexTerminalCMatrix = api;
    window.SpeciedexTerminalModules =
        window.SpeciedexTerminalModules || {};
    window.SpeciedexTerminalModules[
        MODULE_NAME
    ] = api;

    document.dispatchEvent(
        new CustomEvent(
            "speciedex:terminal-module-available",
            {
                detail: {
                    name: MODULE_NAME,
                    module: api
                }
            }
        )
    );
})(window, document);
