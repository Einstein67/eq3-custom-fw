# eQ-3 custom firmware

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/dbuezas)

All the added features, fixes and optimisations this firmware has are in the **[changelog](CHANGELOG.md)**.

## ▶ [Open the app: dbuezas.github.io/eq3-custom-fw](https://dbuezas.github.io/eq3-custom-fw/)

It runs in your browser, talks to the thermostat over Bluetooth, and needs nothing installed.

Chrome or Edge only, on Android, Windows, macOS, Linux or ChromeOS. Safari and Firefox have no Web
Bluetooth, so **iPhones and iPads cannot do this at all**. You can install the page to your home
screen and it works with no network, which matters in a cellar with no wifi.

---

Alternative firmware for the **eQ-3 CC-RT-BLE** Bluetooth radiator thermostat, plus the tools to put
it on one. It keeps everything the original does and adds pair-less encrypted connections, BTHome
broadcasts for Home Assistant, a settable pairing PIN, a screen mirror, the thermostat's own buttons
as a remote control, and longer battery life.

Every eQ-3 firmware version is here too, so you can always put it back exactly as it was.

**[Bluetooth protocol →](PROTOCOL.md)** — everything a program needs to talk to a thermostat, if you
want to build your own integration or app.

**[Home Assistant forum post →](https://community.home-assistant.io/t/custom-firmware-for-the-eq-3-cc-rt-ble-bthome-broadcasts-50-more-battery/1025955)**

## If the page cannot help

[`python-scripts/`](python-scripts/README.md) flashes the same firmware from a computer, and reaches
the thermostat by wire when Bluetooth no longer answers.

```sh
pip install -r python-scripts/requirements.txt
python3 python-scripts/flash.py --list               # which thermostats are in range
python3 python-scripts/flash.py <device>             # install the newest version, both chips
python3 python-scripts/flash.py <device> --versions  # every version on offer
```

## What each script is for

Every one of them explains itself at the top of the file — the wiring, the traps and the measured
numbers live there, not here.

| script | what it does |
|---|---|
| [`flash.py`](python-scripts/flash.py) | **This is the one.** Finds thermostats, and installs a version onto both chips in the right order with a safety check between them. Self-contained. |
| [`ble_chip_via_uart.py`](python-scripts/ble_chip_via_uart.py) | Gets Bluetooth answering again when it has stopped. Needs a USB-UART adapter and the case open — **read its header first.** |

Updating firmware is `flash.py` and nothing else.

## If Bluetooth stops answering

**First:** hold **BOOST** on the main screen to enter pairing mode. That turns the radio back on.

**If it still does not answer**, reach the radio by wire. Open the case and connect a USB-to-serial
adapter to the 5-pin header marked **PRG2**. Pin numbers are as seen with that text the right way up:

| PRG2 pin | what it is | connect to |
|---|---|---|
| 1 | 3.3V | **nothing** |
| 2 | GND | adapter GND |
| 3 | radio RX | adapter **TX** |
| 4 | radio TX | adapter **RX** |
| 5 | VCC | **nothing** |

115200 baud, 8N1. The batteries power the board, so leave pins 1 and 5 unconnected. An ST-Link may
stay connected.

```sh
python3 python-scripts/ble_chip_via_uart.py dump -p /dev/ttyUSB0 -o backup.bin   # optional backup
python3 python-scripts/ble_chip_via_uart.py recover -p /dev/ttyUSB0
```

`recover` installs a rescue radio image. Then **unplug the adapter** (while it is connected the radio
does not start), take the batteries out and put them back, and install a normal version with
`flash.py`.

The rescue image always advertises, twice a second, and never asks for a PIN. It is only meant to get
Bluetooth back, so replace it right away.

## Two chips, one version

A version is two images: the thermostat's and the radio's. `flash.py` always installs both. It does
the thermostat first, and stops before the radio if the thermostat did not confirm its image.

## Afterwards

A freshly flashed thermostat asks for the date and does nothing until it has one — no measuring, no
heating, no broadcasts. Set it from the page, or from eQ-3's own app. That is normal and is not a
failure.

## Going back

The original eQ-3 versions are on offer too, so `flash.py <device> --release 1.48` puts the thermostat
back on stock 1.48, radio included. Nothing here is one-way.

## Warning

This is unofficial firmware, written by reading eQ-3's. It is not from eQ-3, not supported by them,
and it may void your warranty. You are installing it at your own risk.
