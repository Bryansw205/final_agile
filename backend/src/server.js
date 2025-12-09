import { config } from './config.js';
import app from './app.js';

app.listen(config.port, () => {
  console.log(`Backend listening on http://localhost:${config.port}`);
});
