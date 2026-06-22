import React from "react";

interface ErrorBoundaryState {
  error?: Error;
}

export class ErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  override state: ErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="ui-crash-panel" role="alert">
        <section>
          <h1>ProGraph UI crashed</h1>
          <pre>{this.state.error.message}</pre>
          <button
            className="button primary"
            onClick={() => {
              try {
                localStorage.clear();
              } catch {
                // Ignore storage failures; reload is still the useful recovery path.
              }
              location.reload();
            }}
          >
            Clear local preferences and reload
          </button>
        </section>
      </main>
    );
  }
}
