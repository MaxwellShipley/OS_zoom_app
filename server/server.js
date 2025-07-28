import http from 'http';
import debug from 'debug';
import { appName } from '../config.js';

const dbg = debug(`${appName}:http`);

export async function start(app, port) {
    const server = http.createServer(app);

    server.on('listening', () => {
        const addr = server.address();
        const bind = typeof addr === 'string' ? `pipe ${addr}` : `http://localhost:${addr.port}`;
        dbg(`Listening on ${bind}`);
        console.log(`🚀 Server ready at ${bind}`);
        console.log(`➡️  Ensure your ngrok is pointing to port ${addr.port}`);
    });

    server.on('error', async (error) => {
        if (error?.syscall !== 'listen') throw error;
        const bind = typeof port === 'string' ? `Pipe ${port}` : `Port ${port}`;
        switch (error?.code) {
            case 'EACCES': throw new Error(`${bind} requires elevated privileges`);
            case 'EADDRINUSE': throw new Error(`${bind} is already in use`);
            default: throw error;
        }
    });

    return server.listen(port);
}