// Tailwind v3 adapter. 4px spacing grid; use v4 CSS separately.
module.exports={
  "content": [
    "./**/*.{html,js,jsx,tsx}"
  ],
  "theme": {
    "extend": {
      "colors": {
        "background": "var(--background)",
        "surface": "var(--surface)",
        "surface-raised": "var(--surface-raised)",
        "text": "var(--text)",
        "text-muted": "var(--text-muted)",
        "border": "var(--border)",
        "action": "var(--action)",
        "action-text": "var(--action-text)",
        "interactive": "var(--interactive)",
        "focus": "var(--focus)",
        "positive": "var(--positive)",
        "negative": "var(--negative)",
        "warning": "var(--warning)",
        "info": "var(--info)",
        "neutral": "var(--neutral)",
        "chart1": "var(--chart1)",
        "chart2": "var(--chart2)",
        "chart3": "var(--chart3)",
        "chart4": "var(--chart4)"
      },
      "fontSize": {
        "caption": [
          "12px",
          {
            "lineHeight": "1.6"
          }
        ],
        "label": [
          "14px",
          {
            "lineHeight": "1.6"
          }
        ],
        "body": [
          "16px",
          {
            "lineHeight": "1.6"
          }
        ],
        "lead": [
          "20px",
          {
            "lineHeight": "1.6"
          }
        ],
        "h3": [
          "24px",
          {
            "lineHeight": "1.18"
          }
        ],
        "h2": [
          "36px",
          {
            "lineHeight": "1.18"
          }
        ],
        "h1": [
          "56px",
          {
            "lineHeight": "1.18"
          }
        ],
        "display": [
          "80px",
          {
            "lineHeight": "1.18"
          }
        ]
      },
      "fontFamily": {
        "display": [
          "Space Grotesk",
          "sans-serif"
        ],
        "sans": [
          "Inter",
          "Noto Sans Arabic",
          "sans-serif"
        ]
      },
      "spacing": {
        "0": "0px",
        "1": "4px",
        "2": "8px",
        "3": "12px",
        "4": "16px",
        "5": "20px",
        "6": "24px",
        "8": "32px",
        "10": "40px",
        "12": "48px",
        "16": "64px",
        "20": "80px",
        "24": "96px",
        "32": "128px"
      },
      "borderRadius": {
        "sm": "4px",
        "md": "8px",
        "lg": "12px"
      },
      "borderWidth": {
        "DEFAULT": "1px",
        "strong": "2px"
      },
      "boxShadow": {
        "raised": "var(--shadow-raised)",
        "overlay": "var(--shadow-overlay)"
      }
    }
  }
};
