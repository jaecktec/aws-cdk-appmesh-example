const jsonHeaders = {'Content-Type': 'application/json; charset=utf-8'};

const methodNotAllowedHandler = (req, res) => {
    return res.writeHead(405, jsonHeaders).end(JSON.stringify({
        error: 'method_not_allowed',
        description: `no mapping for [${req.method}:${req.url}]`
    }), 'utf-8')
}

const notFoundHandler = (req, res) => {
    return res.writeHead(404, jsonHeaders).end(JSON.stringify({
        error: 'not_found',
        description: `no route found for [${req.method}:${req.url}]`
    }), 'utf-8')
}

module.exports = {
    methodNotAllowedHandler,
    notFoundHandler,
    jsonHeaders,
}
