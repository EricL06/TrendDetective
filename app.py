"""HTTP server module exposing the Python button interface to the web frontend.

This module serves static frontend assets, lists registered buttons at
``GET /api/buttons``, and routes button click events at
``POST /api/buttons/<button_id>`` to the single method bound to that button.
"""

from dataclasses import dataclass
from http.server import HTTPServer, SimpleHTTPRequestHandler
import json
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from interface import AppInterface

BASE_DIR: Path = Path(__file__).resolve().parent
INTERFACE: AppInterface = AppInterface()


@dataclass(frozen=True)
class ServerConfig:
    """Configuration parameters for the HTTP web server.

    :param host: Hostname or IP address to bind the server to.
    :type host: str
    :param port: TCP port number to listen on.
    :type port: int
    """

    host: str = "127.0.0.1"
    port: int = 8000


class WebAppHandler(SimpleHTTPRequestHandler):
    """HTTP request handler serving static files and button API endpoints.

    :param request: Client socket request object.
    :type request: Any
    :param client_address: Client ``(host, port)`` tuple.
    :type client_address: tuple[str, int]
    :param server: Reference to the active :class:`HTTPServer` instance.
    :type server: HTTPServer
    """

    def __init__(
        self,
        request: Any,
        client_address: tuple[str, int],
        server: HTTPServer,
    ) -> None:
        """Initialize the request handler rooted at the project directory.

        :param request: Client socket request object.
        :type request: Any
        :param client_address: Client ``(host, port)`` tuple.
        :type client_address: tuple[str, int]
        :param server: Reference to the active :class:`HTTPServer` instance.
        :type server: HTTPServer
        :return: None
        :rtype: None
        """
        super().__init__(request, client_address, server, directory=str(BASE_DIR))

    def do_GET(self) -> None:
        """Handle HTTP GET requests for button metadata or static files.

        :return: None
        :rtype: None
        """
        if self.path == "/api/buttons":
            payload = json.dumps(INTERFACE.get_buttons_metadata()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        super().do_GET()

    def do_POST(self) -> None:
        """Handle HTTP POST requests to trigger a specific button's bound method.

        Expects paths matching ``/api/buttons/<button_id>``.

        :return: None
        :rtype: None
        """
        prefix = "/api/buttons/"
        if self.path.startswith(prefix):
            button_id = unquote(self.path[len(prefix) :]).strip("/")
            try:
                INTERFACE.trigger_button(button_id)
            except KeyError:
                self.send_error(404, f"Button '{button_id}' not found")
                return

            self.send_response(204)
            self.end_headers()
            return

        self.send_error(404, "Endpoint not found")


def run(config: ServerConfig = ServerConfig()) -> None:
    """Start the HTTP server using the provided server configuration.

    :param config: Server host and port configuration.
    :type config: ServerConfig
    :return: None
    :rtype: None
    """
    server = HTTPServer((config.host, config.port), WebAppHandler)
    print(f"Server running at http://{config.host}:{config.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
    finally:
        server.server_close()


if __name__ == "__main__":
    run()
