import React from 'react';
import { AlertCircle } from 'lucide-react';
import { colors, theme, fonts } from '../theme.js';

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error(`[ErrorBoundary${this.props.tabName ? ` — ${this.props.tabName}` : ''}]`, error, info);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const tabLabel = this.props.tabName ? ` in ${this.props.tabName}` : '';
      return (
        <div style={{
          background: colors.dangerBg,
          border: `1px solid ${colors.dangerBorder}`,
          borderRadius: 3,       // matches theme shape.cardRadius
          padding: '32px 24px',
          textAlign: 'center',
        }}>
          <AlertCircle style={{
            width: 40, height: 40,
            color: colors.danger,
            margin: '0 auto 12px',
            display: 'block',
          }} />
          <h3 style={{
            fontFamily: fonts.serif,
            fontWeight: 600,
            fontSize: 18,
            color: colors.textPrimary,
            marginBottom: 8,
          }}>
            Something went wrong{tabLabel}
          </h3>
          <p style={{
            fontFamily: fonts.sans,
            fontSize: 13,
            color: colors.textSecondary,
            marginBottom: 16,
          }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button
              onClick={this.handleRetry}
              style={{
                ...theme.btnSecondary,
                padding: '8px 16px',
              }}
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                ...theme.btnDanger,
                padding: '8px 16px',
              }}
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
