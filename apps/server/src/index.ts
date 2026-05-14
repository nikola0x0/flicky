const PORT = Number(process.env.PORT ?? 3001)

const server = Bun.serve({
  port: PORT,
  fetch(req, server) {
    const url = new URL(req.url)

    if (url.pathname === "/health") {
      return new Response("ok")
    }

    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req)
      if (upgraded) return
      return new Response("upgrade failed", { status: 400 })
    }

    return new Response("flicky server", { status: 200 })
  },
  websocket: {
    open(ws) {
      ws.send(JSON.stringify({ type: "hello" }))
    },
    message(ws, message) {
      ws.send(message)
    },
    close() {},
  },
})

console.log(`flicky server listening on http://localhost:${server.port}`)
