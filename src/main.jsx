import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './ui/App.jsx';
import { DialogProvider } from './ui/controls.jsx';
import './styles.css';

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('UI error', error, info); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="fatal">
      <h1>Something went wrong</h1>
      <p>{String(this.state.error?.message || this.state.error)}</p>
      <p>Your last changes are kept in the automatic recovery file and will be offered when the app starts again.</p>
      <button type="button" onClick={() => window.location.reload()}>Restart the designer</button>
    </div>;
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode><ErrorBoundary><DialogProvider><App /></DialogProvider></ErrorBoundary></React.StrictMode>
);
