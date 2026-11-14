"""Module defining button models and the Python interface for the web application.

This module uses dataclasses to represent UI buttons and provides ``set_trigger``
to bind each button to a single dedicated Python method.
"""

from collections.abc import Callable
from dataclasses import dataclass, field


@dataclass
class Button:
    """Data model representing a single UI button bound to one Python method.

    :param button_id: Unique identifier matching the HTML button ``id``.
    :type button_id: str
    :param label: Display text or description of the button.
    :type label: str
    :param handler: The single callable method executed when the button is clicked.
    :type handler: Callable[[], None] | None
    """

    button_id: str
    label: str = ""
    handler: Callable[[], None] | None = None

    def set_trigger(self, handler: Callable[[], None]) -> None:
        """Assign the single trigger method to be executed when this button is clicked.

        :param handler: Callable method taking no arguments and returning ``None``.
        :type handler: Callable[[], None]
        :return: None
        :rtype: None
        """
        self.handler = handler

    def trigger(self) -> None:
        """Execute the trigger method associated with this button.

        :raises RuntimeError: If no trigger method has been assigned via :meth:`set_trigger`.
        :return: None
        :rtype: None
        """
        if self.handler is None:
            raise RuntimeError(
                f"Button '{self.button_id}' does not have a trigger method set."
            )
        self.handler()

    def to_metadata(self) -> dict[str, str]:
        """Serialize the public metadata of the button for the frontend.

        :return: Dictionary containing the button's ID and display label.
        :rtype: dict[str, str]
        """
        return {
            "button_id": self.button_id,
            "label": self.label,
        }


@dataclass
class AppInterface:
    """Python interface managing buttons and their dedicated action methods.

    Each button registered in this interface is connected to one method via
    :meth:`Button.set_trigger`.

    :param buttons: Mapping of button IDs to their corresponding :class:`Button` instances.
    :type buttons: dict[str, Button]
    """

    buttons: dict[str, Button] = field(default_factory=dict, init=False)

    def __post_init__(self) -> None:
        """Initialize buttons, assign their triggers, and register them.

        :return: None
        :rtype: None
        """
        detect_button = Button(button_id="detect_trend", label="Detect Trend")
        detect_button.set_trigger(self.on_detect_trend)
        self.register_button(detect_button)

    def register_button(self, button: Button) -> None:
        """Register a button instance in the interface.

        :param button: The button instance to register.
        :type button: Button
        :raises ValueError: If a button with the same ID is already registered.
        :return: None
        :rtype: None
        """
        if button.button_id in self.buttons:
            raise ValueError(f"Button '{button.button_id}' is already registered.")
        self.buttons[button.button_id] = button

    def get_buttons_metadata(self) -> list[dict[str, str]]:
        """Return serialized metadata for all registered buttons.

        :return: List of dictionaries containing each button's ID and label.
        :rtype: list[dict[str, str]]
        """
        return [button.to_metadata() for button in self.buttons.values()]

    def trigger_button(self, button_id: str) -> None:
        """Invoke the trigger method connected to the specified button ID.

        :param button_id: Unique identifier of the clicked button.
        :type button_id: str
        :raises KeyError: If no button matches the given ``button_id``.
        :return: None
        :rtype: None
        """
        if button_id not in self.buttons:
            raise KeyError(f"Unknown button ID: '{button_id}'")
        self.buttons[button_id].trigger()

    def on_detect_trend(self) -> None:
        """Handle clicks for the 'Detect Trend' button.

        Currently does not return anything.

        :return: None
        :rtype: None
        """

        print("Hello World!")

        pass
