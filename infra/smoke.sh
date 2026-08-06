#!/bin/bash
# Runs the real-bwrap contract test inside a Lima VM.
#
# CI's smoke job runs the same test as an ordinary unprivileged user, which
# covers the AppArmor/userns interaction. This script goes further and runs it
# under the systemd hardening a deployed eve agent actually gets
# (NoNewPrivileges, ProtectSystem=strict, PrivateTmp) -- the configuration this
# backend is designed for. Run it before pushing anything that touches
# src/args.ts or src/process.ts; waiting for CI does not cover that dimension.
#
# Prereq: brew install lima
set -euo pipefail
cd "$(dirname "$0")/.."
VM="${SANDBOX_BWRAP_VM:-sandbox-bwrap-test}"
GUEST_DIR=/opt/sandbox-bwrap

if ! limactl list --format '{{.Name}}' | grep -qx "$VM"; then
  echo "==> Creating VM $VM (first run downloads an Ubuntu image)"
  limactl start --name "$VM" infra/lima/sandbox-bwrap.yaml --tty=false
else
  limactl start "$VM" >/dev/null 2>&1 || true
fi

echo "==> Refreshing $GUEST_DIR from the worktree"
# node_modules is kept so pnpm install stays incremental across runs.
limactl shell "$VM" -- sudo bash -c "
  set -euo pipefail
  install -d $GUEST_DIR
  find $GUEST_DIR -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
"

# Only tracked, non-ignored files are streamed, so host state stays on the host.
# COPYFILE_DISABLE stops macOS bsdtar from emitting AppleDouble ("._name")
# companions for files carrying extended attributes; the guest-side --exclude
# drops any that slip through regardless of the host tar flavor.
git ls-files --cached --others --exclude-standard -z |
  COPYFILE_DISABLE=1 tar -czf - --null -T - |
  limactl shell "$VM" -- sudo tar -xzf - -C "$GUEST_DIR" --exclude='._*' 2>/dev/null

echo "==> Installing dependencies"
limactl shell "$VM" -- sudo bash -c "
  set -euo pipefail
  cd $GUEST_DIR
  corepack pnpm install --frozen-lockfile
"

echo "==> Running the bwrap contract test under deployed-agent systemd constraints"
# Run as the unprivileged sandbox-test user: root is exempt from the userns
# sysctl, so a root-only pass would prove nothing about a real deployment.
limactl shell "$VM" -- sudo bash -c "
  set -euo pipefail
  install -d -o sandbox-test -g sandbox-test /var/lib/sandbox-test
  chmod -R a+rX $GUEST_DIR
  systemd-run --wait --pipe --collect --service-type=exec \
    --property=User=sandbox-test \
    --property=NoNewPrivileges=yes \
    --property=ProtectSystem=strict \
    --property=PrivateTmp=yes \
    --property=ReadWritePaths=/var/lib/sandbox-test \
    --setenv=TMPDIR=/var/lib/sandbox-test \
    bash -lc 'cd $GUEST_DIR && ./node_modules/.bin/tsx src/integration/bwrap-backend-smoke.ts'
"
