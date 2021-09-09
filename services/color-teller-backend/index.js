const http = require('http');
const port = process.env['PORT'] || 3001;
const express = require('express');
const {notFoundHandler, methodNotAllowedHandler, jsonHeaders} = require('./error-handler')

const app = express()

const computeGreetingHandler = (req, res) => {
    return res.writeHead(200, jsonHeaders).end(JSON.stringify({
        color: process.env["COLOR"],
    }), 'utf-8')
}
const healthHandler = (req, res) => {
    return res.writeHead(200, jsonHeaders).end(JSON.stringify({
        status: 'up',
    }), 'utf-8')
}

app
    .route(`/color`)
    .get(computeGreetingHandler)
    .all(methodNotAllowedHandler);

app
    .route(`/health`)
    .get(healthHandler)
    .all(methodNotAllowedHandler);

app.use(notFoundHandler);

const server = http.createServer(app)

process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server')

    server.close(() => {
        console.log('HTTP server closed')
    })
})

server.listen(port, () => {
    console.log(
        `The application is listening on port ${port}`,
    );
});
