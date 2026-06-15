#!/usr/bin/env bash
set -euo pipefail

echo "1) Ensure dnf-plugins-core is installed"
dnf -y install dnf-plugins-core

echo "2) Enable CRB"
dnf config-manager --set-enabled crb || true

echo "3) Install EPEL"
dnf -y install epel-release \
|| dnf -y install https://dl.fedoraproject.org/pub/epel/epel-release-latest-9.noarch.rpm

echo "4) Install ffmpeg"
dnf -y install ffmpeg ffmpeg-devel --allowerasing

echo
echo "Done."
ffmpeg -version | head -n 1