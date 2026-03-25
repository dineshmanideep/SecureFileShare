/** @type {import('tailwindcss').Config} */
export default {
    content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
    theme: {
        extend: {
            fontFamily: {
                sans: ["Inter", "system-ui", "sans-serif"],
                mono: ["JetBrains Mono", "monospace"],
            },
            colors: {
                // Primary navy palette
                navy: {
                    50:  "#eef0f7",
                    100: "#d1d6ed",
                    200: "#a3addb",
                    300: "#7585c9",
                    400: "#475eb7",
                    500: "#1a1f36",
                    600: "#171c30",
                    700: "#131829",
                    800: "#0f1322",
                    900: "#0b0e1a",
                    950: "#070911",
                },
                // Electric blue accent
                electric: {
                    50:  "#eef1fe",
                    100: "#d5dcfc",
                    200: "#acb9f9",
                    300: "#8296f6",
                    400: "#5973f3",
                    500: "#4f6ef7",
                    600: "#3555e5",
                    700: "#2840c3",
                    800: "#1f32a0",
                    900: "#182680",
                },
                // Legacy cyber (teal) kept for backward compat
                cyber: {
                    50:  "#f0fdf8",
                    100: "#ccfbef",
                    200: "#99f6e0",
                    300: "#5eead4",
                    400: "#2dd4bf",
                    500: "#14b8a6",
                    600: "#0d9488",
                    700: "#0f766e",
                    800: "#115e59",
                    900: "#134e4a",
                },
                dark: {
                    900: "#050a0e",
                    800: "#0a1628",
                    700: "#0e1f3d",
                    600: "#142952",
                    500: "#1a3568",
                },
                surface: "#f8f9fc",
                card:    "#ffffff",
            },
            backgroundImage: {
                "cyber-grid":
                    "linear-gradient(rgba(20,184,166,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(20,184,166,0.05) 1px, transparent 1px)",
                "hero-glow":
                    "radial-gradient(ellipse 80% 50% at 50% -20%, rgba(79,110,247,0.25), transparent)",
            },
            animation: {
                "pulse-slow":    "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
                glow:            "glow 2s ease-in-out infinite alternate",
                "slide-up":      "slideUp 0.4s ease-out",
                "slide-right":   "slideRight 0.35s ease-out",
                "fade-in":       "fadeIn 0.5s ease-out",
                "bounce-subtle": "bounceSubtle 0.6s ease-out",
            },
            keyframes: {
                glow: {
                    "0%":   { boxShadow: "0 0 5px #4f6ef7, 0 0 10px #4f6ef7" },
                    "100%": { boxShadow: "0 0 20px #4f6ef7, 0 0 40px #4f6ef740" },
                },
                slideUp: {
                    "0%":   { transform: "translateY(20px)", opacity: "0" },
                    "100%": { transform: "translateY(0)",    opacity: "1" },
                },
                slideRight: {
                    "0%":   { transform: "translateX(100%)", opacity: "0" },
                    "100%": { transform: "translateX(0)",     opacity: "1" },
                },
                fadeIn: {
                    "0%":   { opacity: "0" },
                    "100%": { opacity: "1" },
                },
                bounceSubtle: {
                    "0%,100%": { transform: "scale(1)" },
                    "50%":     { transform: "scale(1.05)" },
                },
            },
            boxShadow: {
                card:   "0 1px 3px rgba(0,0,0,0.08), 0 8px 24px rgba(0,0,0,0.04)",
                "card-hover": "0 4px 16px rgba(0,0,0,0.12), 0 16px 40px rgba(0,0,0,0.06)",
                electric: "0 4px 24px rgba(79,110,247,0.3)",
            },
        },
    },
    plugins: [],
};
