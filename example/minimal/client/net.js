import { PORT } from './constants.js';
import { applyMessage } from './protocol.js';

export function connect(state) {
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    state.status = 'Connected';
  };

  ws.onclose = () => {
    state.status = 'Disconnected — refreshing...';
    setTimeout(() => location.reload(), 2000);
  };

  ws.onmessage = (e) => {
    applyMessage(e.data, state.entities);
  };
}
