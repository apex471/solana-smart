import React from "react";

interface State { hasError: boolean; message: string; }

export class ErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { hasError: false, message: "" };

  static getDerivedStateFromError(err: unknown): State {
    const message = err instanceof Error ? err.message : String(err);
    return { hasError: true, message };
  }

  componentDidCatch(err: unknown, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", err, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: "100vh",
          background: "#0d1117",
          color: "#fff",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "Inter, system-ui, sans-serif",
          padding: "2rem",
          textAlign: "center",
        }}>
          <img src="/logo.png" alt="" style={{ width: 100, marginBottom: "1.5rem", mixBlendMode: "screen" }} />
          <h2 style={{ marginBottom: "0.75rem", fontSize: "1.4rem" }}>Something went wrong</h2>
          <p style={{ color: "#8b9ab0", maxWidth: 420, fontSize: "0.9rem", lineHeight: 1.6 }}>
            {this.state.message || "An unexpected error occurred. Please refresh the page."}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: "2rem",
              background: "#c1f000",
              color: "#0d1117",
              border: "none",
              borderRadius: 8,
              padding: "0.7rem 2rem",
              fontWeight: 700,
              fontSize: "0.95rem",
              cursor: "pointer",
            }}
          >
            Refresh
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
