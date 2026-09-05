#!/usr/bin/env bash
# Run this ON the Oracle VM, from inside the voip-test folder you scp'd there:
#   cd ~/voip-test && bash deploy/setup.sh
set -e
cd "$(dirname "$0")/.."
APPDIR="$(pwd)"

# 1. Node LTS (Oracle's Ubuntu image ships without it)
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

npm install --omit=dev

# 2. Open the ports on the VM's own OS firewall.
#    (Oracle's Ubuntu images filter with iptables by default — the cloud
#    console Security List rules alone are NOT enough, both must allow it.)
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 3478 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 3478 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 49152:65535 -j ACCEPT
sudo apt-get install -y iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save 2>/dev/null || true

# 3. Fill in this VM's own public IP for TURN to advertise.
PUBIP=$(curl -s ifconfig.me)
sed -i "s/^EXTERNAL_IP=.*/EXTERNAL_IP=$PUBIP/" deploy/voip.env
echo "EXTERNAL_IP set to $PUBIP"

# 4. Install as a systemd service so it survives SSH logout / reboots.
sudo sed "s#__APPDIR__#$APPDIR#g" deploy/voip.service | sudo tee /etc/systemd/system/voip.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now voip
sleep 1
sudo systemctl status voip --no-pager
