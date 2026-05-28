/**
 * LXD module for managing LXD virtual machines as K3s nodes.
 * @module src/cli/lxd.js
 * @namespace UnderpostLxd
 *
 * ### Design principles
 *
 *   1. **No silent failures.** Every destructive shell call propagates errors.
 *      Idempotency is achieved via explicit pre-condition checks (does the VM
 *      exist? is it running? is the profile present?), not by suppressing
 *      exit codes with `silentOnError` or `|| true`. The earlier "silent on
 *      error" pattern hid corruption signals and is removed everywhere.
 *
 *   2. **Host stays bootable, always.** `--reset` no longer touches the LXD
 *      snap or storage pools. Purging is opt-in via `--purge`, which always
 *      runs `lxd shutdown --timeout 60` first so the daemon can flush the
 *      ZFS pool cleanly. This prevents the dirty-pool-on-next-boot scenario
 *      that previously required a full host reinstall.
 *
 *   3. **Pre-reboot procedure.** `--shutdown` stops every VM gracefully and
 *      then signals the LXD daemon to shut down. Run this before any host
 *      `reboot` / `poweroff` to avoid corrupting the storage pool.
 *
 *   4. **Single source of truth for VM bring-up.** `--init-vm` runs OS base
 *      setup → engine source mirror → K3s role install, end-to-end. There is
 *      no follow-up bootstrap step.
 */

import { getNpmRootPath } from '../server/conf.js';
import { pbcopy, shellExec } from '../server/process.js';
import walk from 'ignore-walk';
import fs from 'fs-extra';
import { loggerFactory } from '../server/logger.js';
import Underpost from '../index.js';

const logger = loggerFactory(import.meta);

const ENGINE_ROOT_IN_VM = '/home/dd/engine';
const ENGINE_ROOT_ON_HOST = '/home/dd/engine';
const ADMIN_PROFILE = 'admin-profile';
const BRIDGE_NETWORK = 'lxdbr0';
const BRIDGE_SUBNET_PREFIX = '10.250.250';

class UnderpostLxd {
  static API = {
    /**
     * @method callback
     * @description Main entry point for all LXD CLI operations.
     * @param {object} options
     * @param {boolean} [options.init=false] - Initialize LXD via preseed.
     * @param {boolean} [options.reset=false] - Host-safe teardown of VMs, proxy
     *   devices, admin-profile, and lxdbr0. Does NOT touch the LXD snap or
     *   storage pools.
     * @param {boolean} [options.purge=false] - Gracefully shut the LXD daemon
     *   down (60s timeout) and remove the LXD snap. Combine with `--reset` to
     *   wipe per-VM state first. Without `--reset`, snap removal alone wipes
     *   everything.
     * @param {boolean} [options.shutdown=false] - Pre-host-reboot procedure:
     *   gracefully stop every VM and the LXD daemon. Run before `reboot` /
     *   `poweroff` to keep the host bootable.
     * @param {boolean} [options.restore=false] - Symmetric to `--shutdown`:
     *   starts the LXD daemon (`snap start lxd`), waits for it to become
     *   responsive, then starts every VM that exists. VMs created with
     *   `admin-profile` have `boot.autostart=false`, so this is the explicit
     *   "bring the lab back online" command.
     * @param {boolean} [options.dev=false] - Use local paths instead of npm global.
     * @param {boolean} [options.install=false] - Install LXD snap.
     * @param {boolean} [options.createVirtualNetwork=false] - Create lxdbr0 bridge network.
     * @param {string} [options.ipv4Address='10.250.250.1/24'] - IPv4 address/CIDR for lxdbr0.
     * @param {boolean} [options.createAdminProfile=false] - Create admin-profile for VMs.
     * @param {boolean} [options.control=false] - Initialize VM as K3s control plane.
     * @param {boolean} [options.worker=false] - Initialize VM as K3s worker.
     * @param {string} [options.initVm=''] - VM name to bring up as a K3s node end-to-end.
     * @param {string} [options.deleteVm=''] - VM name to safely stop and delete.
     * @param {string} [options.createVm=''] - VM name to create (copies command to clipboard).
     * @param {string} [options.infoVm=''] - VM name to inspect.
     * @param {string} [options.rootSize=''] - Root disk size in GiB for new VMs.
     * @param {string} [options.joinNode=''] - Join format: 'workerName,controlName'.
     * @param {string} [options.expose=''] - Expose VM ports to host: 'vmName:port1,port2'.
     * @param {string} [options.deleteExpose=''] - Remove exposed ports: 'vmName:port1,port2'.
     * @param {string} [options.test=''] - VM name for connectivity and health checks.
     * @param {boolean} [options.copy=false] - For two-phase flows that surface a
     *   command for the user to execute (e.g. `--create-admin-profile` phase 1):
     *   when set, copy the command to the clipboard. When unset, print it to
     *   the terminal so the user can read it directly.
     * @memberof UnderpostLxd
     */
    async callback(
      options = {
        init: false,
        reset: false,
        purge: false,
        shutdown: false,
        restore: false,
        dev: false,
        install: false,
        createVirtualNetwork: false,
        ipv4Address: '10.250.250.1/24',
        createAdminProfile: false,
        control: false,
        worker: false,
        initVm: '',
        deleteVm: '',
        createVm: '',
        infoVm: '',
        rootSize: '',
        joinNode: '',
        expose: '',
        deleteExpose: '',
        test: '',
        copy: false,
      },
    ) {
      const npmRoot = getNpmRootPath();
      const underpostRoot = options?.dev === true ? '.' : `${npmRoot}/underpost`;

      // =====================================================================
      // SHUTDOWN: graceful pre-host-reboot procedure
      // =====================================================================
      if (options.shutdown === true) {
        UnderpostLxd._gracefulShutdownAll();
        return;
      }

      // =====================================================================
      // RESTORE: symmetric counterpart to --shutdown
      // =====================================================================
      if (options.restore === true) {
        UnderpostLxd._restoreAll();
        return;
      }

      // =====================================================================
      // RESET / PURGE: host-safe teardown variants
      //   --reset       wipes VMs, proxy devices, admin-profile, lxdbr0
      //   --purge       gracefully stops the daemon, then snap remove --purge
      //   --reset --purge   both, in order
      // =====================================================================
      if (options.reset === true) {
        UnderpostLxd._safeReset();
      }
      if (options.purge === true) {
        UnderpostLxd._safePurge();
      }
      if (options.reset === true || options.purge === true) return;

      // =====================================================================
      // INSTALL (idempotent: skip if already installed)
      // =====================================================================
      if (options.install === true) {
        if (UnderpostLxd._snapInstalled('lxd')) {
          logger.info('LXD snap is already installed; skipping.');
        } else {
          shellExec(`sudo snap install lxd`);
        }
      }

      // =====================================================================
      // INIT (LXD preseed)
      // =====================================================================
      if (options.init === true) {
        shellExec(`sudo systemctl start snap.lxd.daemon`);
        shellExec(`sudo systemctl status snap.lxd.daemon`);
        const lxdPreseedContent = fs
          .readFileSync(`${underpostRoot}/manifests/lxd/lxd-preseed.yaml`, 'utf8')
          .replaceAll(`127.0.0.1`, Underpost.dns.getLocalIPv4Address());
        shellExec(`echo "${lxdPreseedContent}" | lxd init --preseed`);
        shellExec(`lxc cluster list`);
      }

      // =====================================================================
      // CREATE VIRTUAL NETWORK
      // =====================================================================
      if (options.createVirtualNetwork === true) {
        const ipv4Address = options.ipv4Address ? options.ipv4Address : '10.250.250.1/24';
        const bridgeSettings = {
          'ipv4.address': ipv4Address,
          'ipv4.nat': 'true',
          'ipv4.dhcp': 'true',
          'ipv4.firewall': 'true',
          'dns.mode': 'managed',
          'ipv6.address': 'none',
        };

        if (UnderpostLxd._networkExists(BRIDGE_NETWORK)) {
          logger.info(`Network '${BRIDGE_NETWORK}' already exists; reconciling managed bridge settings.`);
        } else {
          shellExec(`lxc network create ${BRIDGE_NETWORK}`);
        }

        for (const [key, value] of Object.entries(bridgeSettings)) {
          shellExec(`lxc network set ${BRIDGE_NETWORK} ${key} ${value}`);
        }
        shellExec(`sudo firewall-cmd --permanent --zone=trusted --add-interface=${BRIDGE_NETWORK}`);
        shellExec(`sudo firewall-cmd --reload`);
      }

      // =====================================================================
      // CREATE ADMIN PROFILE (two-phase to sidestep `lxc profile create` hangs)
      //
      // Phase 1 (profile absent): copy `lxc profile create admin-profile` to
      //   the clipboard and exit. The user runs it themselves in their shell.
      // Phase 2 (profile present): load the YAML into the existing profile.
      //
      // Driven by an explicit pre-condition check; no shell command runs that
      // could hang waiting on stdin/tty.
      // =====================================================================
      if (options.createAdminProfile === true) {
        if (!UnderpostLxd._profileExists(ADMIN_PROFILE)) {
          const createCmd = `lxc profile create ${ADMIN_PROFILE}`;
          if (options.copy === true) {
            logger.warn(
              `Profile '${ADMIN_PROFILE}' does not exist. The create command has been copied to your clipboard — run it, then re-run this command to load the YAML.`,
            );
            pbcopy(createCmd);
          } else {
            logger.warn(
              `Profile '${ADMIN_PROFILE}' does not exist. Run the command below in your shell, then re-run this command to load the YAML. (Pass --copy to put it on the clipboard instead.)`,
            );
            console.log(`\n  ${createCmd}\n`);
          }
        } else {
          shellExec(`cat ${underpostRoot}/manifests/lxd/lxd-admin-profile.yaml | lxc profile edit ${ADMIN_PROFILE}`);
          shellExec(`lxc profile show ${ADMIN_PROFILE}`);
        }
      }

      // =====================================================================
      // DELETE VM (idempotent via pre-condition checks; no silent errors)
      // =====================================================================
      if (options.deleteVm) {
        UnderpostLxd._safeDeleteVm(options.deleteVm);
      }

      // =====================================================================
      // CREATE VM (surface the launch command for the user to run)
      //
      // Default: print to terminal. With `--copy`: copy to clipboard.
      // Same two-phase pattern as `--create-admin-profile`: the CLI never runs
      // `lxc launch` itself (it can hang on first image fetch or AppArmor
      // negotiation in some snap setups), so the user always invokes it.
      // =====================================================================
      if (options.createVm) {
        const launchCmd = `lxc launch images:rockylinux/9 ${
          options.createVm
        } --vm --target lxd-node1 -c limits.cpu=2 -c limits.memory=4GB --profile ${ADMIN_PROFILE} -d root,size=${
          options.rootSize ? options.rootSize + 'GiB' : '32GiB'
        }`;
        if (options.copy === true) {
          logger.info(`Launch command for VM '${options.createVm}' copied to clipboard. Run it in your shell.`);
          pbcopy(launchCmd);
        } else {
          logger.info(
            `Run the launch command below in your shell to create VM '${options.createVm}'. (Pass --copy to put it on the clipboard instead.)`,
          );
          console.log(`\n  ${launchCmd}\n`);
        }
      }

      // =====================================================================
      // INIT VM (OS setup + engine bootstrap + K3s role)
      // =====================================================================
      if (options.initVm) {
        const vmName = options.initVm;
        if (!UnderpostLxd._vmExists(vmName)) {
          throw new Error(`VM '${vmName}' does not exist. Create it first with --create-vm.`);
        }
        const lxdSetupPath = `${underpostRoot}/scripts/lxd-vm-setup.sh`;
        const k3sSetupPath = `${underpostRoot}/scripts/k3s-node-setup.sh`;

        // Step 1: OS base setup. Pass a deterministic per-VM static fallback IP
        // so multiple VMs that fail DHCP don't all collide on 10.250.250.100
        // and break K3s worker→control joins.
        const fallbackIp = UnderpostLxd._allocateFallbackIp(vmName);
        logger.info(`[${vmName}] Step 1/3: OS base setup (DHCP fallback IP: ${fallbackIp}/24)...`);
        shellExec(`cat ${lxdSetupPath} | lxc exec ${vmName} --env LXD_FALLBACK_IPV4_CIDR=${fallbackIp}/24 -- bash`);

        // Step 2: Mirror /home/dd/engine into the VM. Mandatory: the K3s role
        // setup resolves every command via `node bin ...` from this directory,
        // not from a global `underpost` install.
        logger.info(`[${vmName}] Step 2/3: Bootstrapping engine source into VM...`);
        await UnderpostLxd._bootstrapEngineSource(vmName);

        // Step 3: K3s role setup, driven by the local engine source.
        logger.info(`[${vmName}] Step 3/3: K3s role setup...`);
        const baseArgs = `--engine-root=${ENGINE_ROOT_IN_VM}`;
        if (options.worker === true) {
          if (!options.joinNode) {
            throw new Error(
              `--init-vm --worker requires --join-node <controlVmName>. A worker is meaningless without a control plane to join; the script would only fail after npm install completes.`,
            );
          }
          const controlNode = options.joinNode.includes(',') ? options.joinNode.split(',').pop() : options.joinNode;
          const { ip: controlPlaneIp, token: k3sToken } = UnderpostLxd._readControlPlaneJoinInfo(controlNode);
          logger.info(`[${vmName}] Joining control plane ${controlNode} (${controlPlaneIp})`);
          shellExec(
            `cat ${k3sSetupPath} | lxc exec ${vmName} -- bash -s -- ${baseArgs} --worker --control-ip=${controlPlaneIp} --token=${k3sToken}`,
          );
        } else {
          shellExec(`cat ${k3sSetupPath} | lxc exec ${vmName} -- bash -s -- ${baseArgs} --control`);
        }
        logger.info(`[${vmName}] Init complete. Engine mirrored at ${ENGINE_ROOT_IN_VM}.`);
      }

      // =====================================================================
      // STANDALONE JOIN
      // =====================================================================
      if (options.joinNode && !options.initVm) {
        const [workerNode, controlNode] = options.joinNode.split(',');
        if (!workerNode || !controlNode) {
          throw new Error(`--join-node standalone requires 'workerName,controlName' format.`);
        }
        if (!UnderpostLxd._vmExists(workerNode)) {
          throw new Error(`Worker VM '${workerNode}' does not exist.`);
        }
        const { ip: controlPlaneIp, token: k3sToken } = UnderpostLxd._readControlPlaneJoinInfo(controlNode);
        const k3sSetupPath = `${underpostRoot}/scripts/k3s-node-setup.sh`;
        logger.info(`Joining K3s worker ${workerNode} to control plane ${controlNode} (${controlPlaneIp})`);
        shellExec(
          `cat ${k3sSetupPath} | lxc exec ${workerNode} -- bash -s -- --engine-root=${ENGINE_ROOT_IN_VM} --worker --control-ip=${controlPlaneIp} --token=${k3sToken}`,
        );
        logger.info(`Worker ${workerNode} joined successfully.`);
      }

      // =====================================================================
      // INFO VM
      // =====================================================================
      if (options.infoVm) {
        shellExec(`lxc config show ${options.infoVm}`);
        shellExec(`lxc info --show-log ${options.infoVm}`);
        shellExec(`lxc info ${options.infoVm}`);
        shellExec(`lxc list ${options.infoVm}`);
      }

      // =====================================================================
      // EXPOSE (proxy host ports to VM)
      // =====================================================================
      if (options.expose) {
        const [vmName, ports] = options.expose.split(':');
        const protocols = ['tcp'];
        const hostIp = Underpost.dns.getLocalIPv4Address();
        const vmIp = UnderpostLxd._vmIpv4(vmName);
        if (!vmIp) {
          throw new Error(`Could not resolve VM IP for ${vmName}. Cannot expose ports.`);
        }
        for (const port of ports.split(',')) {
          for (const protocol of protocols) {
            const deviceName = `${vmName}-${protocol}-port-${port}`;
            if (UnderpostLxd._vmHasDevice(vmName, deviceName)) {
              shellExec(`lxc config device remove ${vmName} ${deviceName}`);
            }
            shellExec(
              `lxc config device add ${vmName} ${deviceName} proxy listen=${protocol}:${hostIp}:${port} connect=${protocol}:${vmIp}:${port} nat=true`,
            );
            logger.info(`Exposed ${protocol}:${hostIp}:${port} -> ${vmIp}:${port} on ${vmName}`);
          }
        }
      }

      // =====================================================================
      // DELETE EXPOSE
      // =====================================================================
      if (options.deleteExpose) {
        const [vmName, ports] = options.deleteExpose.split(':');
        const protocols = ['tcp'];
        for (const port of ports.split(',')) {
          for (const protocol of protocols) {
            const deviceName = `${vmName}-${protocol}-port-${port}`;
            if (UnderpostLxd._vmHasDevice(vmName, deviceName)) {
              shellExec(`lxc config device remove ${vmName} ${deviceName}`);
            } else {
              logger.info(`Device ${deviceName} not present on ${vmName}; skipping.`);
            }
          }
        }
      }

      // =====================================================================
      // TEST (connectivity and health checks)
      // =====================================================================
      if (options.test) {
        const vmName = options.test;
        const vmIp = UnderpostLxd._vmIpv4(vmName);
        logger.info(`VM ${vmName} IPv4: ${vmIp || 'none'}`);
        const httpStatus = shellExec(
          `lxc exec ${vmName} -- curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://google.com`,
          { stdout: true },
        ).trim();
        logger.info(`VM ${vmName} HTTP connectivity: ${httpStatus}`);
        logger.info(`Health report for VM: ${vmName}`);
        shellExec(`lxc list ${vmName} --format json`);
        shellExec(`lxc exec ${vmName} -- bash -c 'top -bn1 | grep "Cpu(s)"'`);
        shellExec(`lxc exec ${vmName} -- bash -c 'free -m'`);
        shellExec(`lxc exec ${vmName} -- bash -c 'df -h /'`);
        shellExec(`lxc exec ${vmName} -- bash -c 'ip a'`);
        shellExec(`lxc exec ${vmName} -- bash -c 'cat /etc/resolv.conf'`);
        shellExec(`lxc exec ${vmName} -- bash -c 'sudo k3s kubectl get nodes'`);
      }
    },
  };

  // =====================================================================
  // PRIVATE HELPERS — lookups that legitimately tolerate "absent" return
  // values do so via list-style commands that always exit 0, not by
  // suppressing error signals from destructive commands.
  // =====================================================================

  /**
   * Lists all LXD VM (virtual-machine) instance names. Returns [] when no VMs.
   * `lxc list --format json` always exits 0; an empty cluster yields `[]`.
   * @returns {string[]}
   * @private
   */
  static _listVms() {
    const raw = shellExec(`lxc list --format json | jq -r '.[] | select(.type=="virtual-machine") | .name // empty'`, {
      stdout: true,
    }).trim();
    if (!raw) return [];
    return raw.split('\n').filter((n) => n.length > 0);
  }

  /**
   * Returns the named VM's status string (e.g. 'Running', 'Stopped', 'Frozen')
   * or `null` if the VM does not exist. Never throws on absence.
   * @param {string} vmName
   * @returns {string|null}
   * @private
   */
  static _vmState(vmName) {
    const raw = shellExec(`lxc list ${vmName} --format json`, { stdout: true }).trim();
    if (!raw) return null;
    const arr = JSON.parse(raw);
    const inst = Array.isArray(arr) ? arr.find((i) => i?.name === vmName) : null;
    return inst ? inst.status || 'Unknown' : null;
  }

  /**
   * @param {string} vmName
   * @returns {boolean}
   * @private
   */
  static _vmExists(vmName) {
    return UnderpostLxd._vmState(vmName) !== null;
  }

  /**
   * Resolves the VM's primary IPv4, preferring the guest interface that owns
   * the default route. This avoids selecting K3s bridge/CNI addresses like
   * 10.42.0.1 after the control plane comes up.
   * @param {string} vmName
   * @returns {string}
   * @private
   */
  static _vmIpv4(vmName) {
    const defaultRoute = shellExec(`lxc exec ${vmName} -- ip -4 -o route show default`, { stdout: true }).trim();
    const defaultRouteTokens = defaultRoute ? defaultRoute.split(/\s+/) : [];
    const devIndex = defaultRouteTokens.indexOf('dev');
    const defaultIface = devIndex >= 0 ? defaultRouteTokens[devIndex + 1] || '' : '';

    if (defaultIface) {
      const defaultIfaceAddr = shellExec(`lxc exec ${vmName} -- ip -4 -o addr show dev ${defaultIface} scope global`, {
        stdout: true,
      }).trim();
      const routeScopedIp = defaultIfaceAddr.match(/\binet\s+([0-9.]+)\//)?.[1] || '';
      if (routeScopedIp) return routeScopedIp;
    }

    return shellExec(
      `lxc list ${vmName} --format json | jq -r '[.[0].state.network | to_entries[] | select(.key!="lo") | .value.addresses[]? | select(.family=="inet" and .scope=="global") | .address | select(test("^10\\.42\\.|^10\\.43\\.|^169\\.254\\.") | not)] | .[0] // empty'`,
      { stdout: true },
    ).trim();
  }

  /**
   * Returns true if a named device is currently attached (expanded) to the VM.
   * @param {string} vmName
   * @param {string} deviceName
   * @returns {boolean}
   * @private
   */
  static _vmHasDevice(vmName, deviceName) {
    if (!UnderpostLxd._vmExists(vmName)) return false;
    const raw = shellExec(`lxc query /1.0/instances/${vmName}?recursion=1 | jq -r '.expanded_devices // {} | keys[]'`, {
      stdout: true,
    }).trim();
    if (!raw) return false;
    return raw.split('\n').some((n) => n.trim() === deviceName);
  }

  /**
   * @param {string} name
   * @returns {boolean}
   * @private
   */
  static _profileExists(name) {
    const raw = shellExec(`lxc profile list --format json`, { stdout: true }).trim();
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) && arr.some((p) => p?.name === name);
  }

  /**
   * @param {string} name
   * @returns {boolean}
   * @private
   */
  static _networkExists(name) {
    const raw = shellExec(`lxc network list --format json`, { stdout: true }).trim();
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) && arr.some((n) => n?.name === name);
  }

  /**
   * Returns true if a snap with the given name is installed. `snap list` exits
   * 0 with the full installed-snap table; we grep for an exact-name row.
   * @param {string} name
   * @returns {boolean}
   * @private
   */
  static _snapInstalled(name) {
    const raw = shellExec(`snap list`, { stdout: true });
    return raw.split('\n').some((line) => new RegExp(`^${name}\\s`).test(line));
  }

  /**
   * Deterministic per-VM IPv4 in the lxdbr0 /24, used as the static fallback
   * inside lxd-vm-setup.sh when DHCP is unavailable. The previous shared
   * `10.250.250.100/24` fallback caused IP collisions across VMs and broke
   * worker→control K3s joins (the worker dialed its own NIC). Offset is the
   * sum of vmName char codes mod 253, +2 — avoids .0, .1 (gateway), .255.
   * @param {string} vmName
   * @returns {string}
   * @private
   */
  static _allocateFallbackIp(vmName) {
    let sum = 0;
    for (let i = 0; i < vmName.length; i++) sum += vmName.charCodeAt(i);
    return `${BRIDGE_SUBNET_PREFIX}.${(sum % 253) + 2}`;
  }

  /**
   * Reads the K3s join info (control plane IPv4 + node token) from a running
   * control VM. Throws if either value is missing — callers depend on both.
   * @param {string} controlNode
   * @returns {{ip: string, token: string}}
   * @private
   */
  static _readControlPlaneJoinInfo(controlNode) {
    if (!UnderpostLxd._vmExists(controlNode)) {
      throw new Error(`Control node VM '${controlNode}' does not exist.`);
    }
    const token = shellExec(`lxc exec ${controlNode} -- bash -c 'sudo cat /var/lib/rancher/k3s/server/node-token'`, {
      stdout: true,
    }).trim();
    const ip = UnderpostLxd._vmIpv4(controlNode);
    if (!ip || !token) {
      throw new Error(`Could not read join info from control node '${controlNode}' (ip='${ip}', token='${token}').`);
    }
    return { ip, token };
  }

  /**
   * Enumerates and removes every device of `type: proxy` attached to a VM.
   * Naming-agnostic. Skips if the VM is already gone; otherwise every
   * `lxc config device remove` call propagates errors loudly.
   * @param {string} vmName
   * @private
   */
  static _removeProxyDevices(vmName) {
    if (!UnderpostLxd._vmExists(vmName)) {
      logger.info(`  Skipping proxy cleanup: VM '${vmName}' is already gone.`);
      return;
    }
    logger.info(`  Removing proxy devices from ${vmName}...`);
    const devicesRaw = shellExec(
      `lxc query /1.0/instances/${vmName}?recursion=1 | jq -r '.expanded_devices // {} | to_entries[] | select(.value.type=="proxy") | .key'`,
      { stdout: true },
    ).trim();
    if (!devicesRaw) {
      logger.info(`  No proxy devices found on ${vmName}.`);
      return;
    }
    for (const deviceName of devicesRaw.split('\n')) {
      const name = deviceName.trim();
      if (!name) continue;
      logger.info(`    Removing device: ${name}`);
      shellExec(`lxc config device remove ${vmName} ${name}`);
    }
  }

  /**
   * Delegates K3s teardown inside a running VM to the centralized
   * `safeResetK3s` in src/cli/cluster.js via `lxc exec`. No-op when K3s or the
   * engine mirror is missing. Bounded by `timeout 300`.
   * @param {string} vmName
   * @param {'drain'|'full'} resetMode - `drain` preserves K3s for next boot
   *   (`--shutdown`); `full` uninstalls (`--delete-vm` / `--reset` / `--purge`).
   * @private
   */
  static _resetK3sInVm(vmName, resetMode) {
    if (UnderpostLxd._vmState(vmName) !== 'Running') return;
    const m = resetMode === 'drain' ? 'drain' : 'full';
    const probe = `if test -x /usr/local/bin/k3s && test -d ${ENGINE_ROOT_IN_VM}/bin; then echo yes; else echo no; fi`;
    const probeOut = shellExec(`lxc exec ${vmName} -- bash -c '${probe}'`, { stdout: true }).trim();
    if (probeOut !== 'yes') {
      logger.info(`  [${vmName}] No K3s+engine detected (probe=${probeOut}); skipping K3s reset.`);
      return;
    }
    logger.info(`  [${vmName}] Resetting K3s (resetMode=${m}) via 'node bin cluster --reset --k3s --reset-mode=${m}'`);
    shellExec(
      `timeout 300 lxc exec ${vmName} -- bash -lc 'cd ${ENGINE_ROOT_IN_VM} && node bin cluster --dev --reset --k3s --reset-mode=${m}'`,
    );
  }

  /**
   * Safely deletes a single VM. Pre-conditions gate every step; absence is a
   * no-op, but unexpected failures propagate.
   *
   *   1. If VM is absent → log and return.
   *   2. Remove every proxy device (clears iptables NAT before the VM goes away).
   *   3. If state is Running/Frozen → graceful stop with 30 s timeout.
   *   4. Delete the VM.
   *
   * @param {string} vmName
   * @private
   */
  static _safeDeleteVm(vmName) {
    const state = UnderpostLxd._vmState(vmName);
    if (state === null) {
      logger.info(`VM '${vmName}' does not exist. Nothing to do.`);
      return;
    }
    logger.info(`Deleting VM '${vmName}' (current state: ${state})...`);
    UnderpostLxd._removeProxyDevices(vmName);
    if (state === 'Running' || state === 'Frozen') {
      UnderpostLxd._resetK3sInVm(vmName, 'full');
      logger.info(`  Stopping VM: ${vmName}`);
      shellExec(`lxc stop ${vmName} --timeout 60`);
    }
    logger.info(`  Deleting VM: ${vmName}`);
    shellExec(`lxc delete ${vmName}`);
    logger.info(`VM ${vmName} deleted.`);
  }

  /**
   * Host-safe reset. Wipes per-VM state and the network/profile this CLI owns.
   * Leaves the LXD snap and storage pools intact so the host stays bootable
   * even if the daemon has internal issues. Use `--purge` for snap removal.
   *
   *   Phase 1: Remove proxy devices from every VM (clears iptables NAT rules).
   *   Phase 2: Stop running VMs gracefully (30 s timeout each).
   *   Phase 3: Delete every VM.
   *   Phase 4: Drop `admin-profile` and the `lxdbr0` network if they exist.
   *
   * @private
   */
  static _safeReset() {
    logger.info('=== LXD RESET (host-safe) ===');
    const vmList = UnderpostLxd._listVms();

    logger.info(`Phase 1/4: Removing proxy devices from ${vmList.length} VM(s)...`);
    for (const vmName of vmList) {
      UnderpostLxd._removeProxyDevices(vmName);
    }

    logger.info('Phase 2/4: Full K3s teardown + stopping running VMs gracefully...');
    for (const vmName of vmList) {
      const state = UnderpostLxd._vmState(vmName);
      if (state === 'Running' || state === 'Frozen') {
        UnderpostLxd._resetK3sInVm(vmName, 'full');
        logger.info(`  Stopping VM: ${vmName}`);
        shellExec(`lxc stop ${vmName} --timeout 60`);
      } else if (state !== null) {
        logger.info(`  VM ${vmName} already in state: ${state}`);
      }
    }

    logger.info('Phase 3/4: Deleting all VMs...');
    for (const vmName of vmList) {
      if (UnderpostLxd._vmExists(vmName)) {
        logger.info(`  Deleting VM: ${vmName}`);
        shellExec(`lxc delete ${vmName}`);
      }
    }

    logger.info(`Phase 4/4: Removing ${ADMIN_PROFILE} and ${BRIDGE_NETWORK} if present...`);
    if (UnderpostLxd._profileExists(ADMIN_PROFILE)) {
      shellExec(`lxc profile delete ${ADMIN_PROFILE}`);
    }
    if (UnderpostLxd._networkExists(BRIDGE_NETWORK)) {
      shellExec(`lxc network delete ${BRIDGE_NETWORK}`);
    }

    logger.info('=== LXD RESET COMPLETE ===');
    logger.info('Snap and storage pools were NOT touched. Use --purge to remove the LXD snap.');
  }

  /**
   * Removes the LXD snap. ALWAYS preceded by `lxd shutdown --timeout 60` so
   * the daemon flushes the ZFS pool cleanly. Without that flush, removing the
   * snap while VMs are running and the pool is dirty has historically left the
   * host unbootable. This is the safe variant.
   *
   * @private
   */
  static _safePurge() {
    logger.info('=== LXD PURGE (DESTRUCTIVE) ===');
    if (!UnderpostLxd._snapInstalled('lxd')) {
      logger.info('LXD snap is not installed. Nothing to purge.');
      return;
    }
    // Drain K3s inside every VM before lxd shutdown so containerd unmounts
    // cleanly and the ZFS pool isn't dirty when the daemon flushes.
    const vmList = UnderpostLxd._listVms();
    if (vmList.length > 0) {
      logger.info(`Phase 1/3: Full K3s teardown inside ${vmList.length} VM(s)...`);
      for (const vmName of vmList) UnderpostLxd._resetK3sInVm(vmName, 'full');
    } else {
      logger.info('Phase 1/3: No VMs to process.');
    }
    logger.info('Phase 2/3: Asking LXD daemon to shut down cleanly (60s timeout)...');
    // `lxd` lives at /snap/bin/lxd which is not in sudo's secure_path on most
    // distros. Forward PATH explicitly so sudo can resolve the binary.
    shellExec(`sudo env PATH="$PATH:/snap/bin" lxd shutdown --timeout 60`);
    logger.info('Phase 3/3: Removing LXD snap and ALL its data (instances, storage pools)...');
    shellExec(`sudo snap remove lxd --purge`);
    logger.info('=== LXD PURGE COMPLETE ===');
  }

  /**
   * Pre-host-reboot procedure. Gracefully stops every running VM, then asks
   * the LXD daemon to shut down. Run this before `reboot` / `poweroff` so the
   * storage pool is clean on next boot.
   *
   * @private
   */
  static _gracefulShutdownAll() {
    logger.info('=== LXD GRACEFUL SHUTDOWN (pre-host-reboot) ===');
    const vmList = UnderpostLxd._listVms();
    for (const vmName of vmList) {
      const state = UnderpostLxd._vmState(vmName);
      if (state === 'Running' || state === 'Frozen') {
        UnderpostLxd._resetK3sInVm(vmName, 'drain');
        logger.info(`  Stopping VM: ${vmName} (timeout 60s)`);
        shellExec(`lxc stop ${vmName} --timeout 60`);
      } else {
        logger.info(`  VM ${vmName} already in state: ${state}`);
      }
    }
    if (UnderpostLxd._snapInstalled('lxd')) {
      logger.info('Asking LXD daemon to shut down cleanly (timeout 60s)...');
      // sudo's secure_path excludes /snap/bin on most distros — forward PATH.
      shellExec(`sudo env PATH="$PATH:/snap/bin" lxd shutdown --timeout 60`);
    }
    logger.info('=== HOST IS SAFE TO REBOOT/POWEROFF ===');
  }

  /**
   * Symmetric counterpart to `_gracefulShutdownAll`. Brings the lab back up:
   *
   *   1. Start the LXD daemon via `snap start lxd` (idempotent).
   *   2. Wait up to 30 s for `lxc info` to respond, so we don't race the
   *      daemon's socket-bring-up.
   *   3. Start every VM that exists. Skips VMs that are already Running.
   *
   * VMs created with `admin-profile` have `boot.autostart=false` by design
   * (host-safety), so this command is how you explicitly bring them online.
   *
   * @private
   */
  static _restoreAll() {
    logger.info('=== LXD RESTORE (bring lab back up) ===');
    if (!UnderpostLxd._snapInstalled('lxd')) {
      throw new Error('LXD snap is not installed; nothing to restore.');
    }
    logger.info('Starting LXD daemon...');
    shellExec(`sudo snap start lxd`);

    // Wait for the daemon's REST socket to be responsive before issuing
    // instance commands. `lxc info` (no args) is the cheapest readiness probe.
    logger.info('Waiting for LXD daemon to become responsive...');
    let ready = false;
    for (let i = 0; i < 15; i++) {
      try {
        shellExec(`lxc info`, { stdout: true });
        ready = true;
        break;
      } catch (err) {
        if (i === 0) logger.info(`  (daemon not ready yet: ${err.message.split('\n')[0]})`);
      }
      shellExec(`sleep 2`);
    }
    if (!ready) {
      throw new Error('LXD daemon did not become responsive within 30s.');
    }
    logger.info('LXD daemon is responsive.');

    const vmList = UnderpostLxd._listVms();
    logger.info(`Starting ${vmList.length} VM(s)...`);
    for (const vmName of vmList) {
      const state = UnderpostLxd._vmState(vmName);
      if (state === 'Running') {
        logger.info(`  ${vmName} already running.`);
      } else {
        logger.info(`  Starting VM: ${vmName} (was: ${state})`);
        shellExec(`lxc start ${vmName}`);
      }
    }
    logger.info('=== LXD RESTORE COMPLETE ===');
  }

  /**
   * Replicates `/home/dd/engine` on the host into the VM, respecting the
   * project `.gitignore`. If `engine-private/` exists on the host it is
   * pushed in a second pass (it is gitignored at the root by design).
   *
   * Idempotent: replaces only the contents of `ENGINE_ROOT_IN_VM`, not the
   * directory inode (avoids races with running watchers / shells inside the VM).
   *
   * @param {string} vmName
   * @private
   */
  static async _bootstrapEngineSource(vmName) {
    if (!UnderpostLxd._vmExists(vmName)) {
      throw new Error(`Cannot bootstrap engine into '${vmName}': VM does not exist.`);
    }
    if (!fs.existsSync(ENGINE_ROOT_ON_HOST)) {
      throw new Error(`Host engine source missing at ${ENGINE_ROOT_ON_HOST}.`);
    }

    const includesFile = `/tmp/lxd-push-${vmName}-${Date.now()}.txt`;
    const files = await new Promise((resolve, reject) =>
      walk(
        { path: ENGINE_ROOT_ON_HOST, ignoreFiles: ['.gitignore'], includeEmpty: false, follow: false },
        (err, result) => (err ? reject(err) : resolve(result)),
      ),
    );
    fs.writeFileSync(includesFile, files.join('\n'));

    shellExec(
      `lxc exec ${vmName} -- bash -c 'mkdir -p ${ENGINE_ROOT_IN_VM} && find ${ENGINE_ROOT_IN_VM} -mindepth 1 -delete'`,
    );
    shellExec(
      `tar -C ${ENGINE_ROOT_ON_HOST} -cf - --files-from=${includesFile} | lxc exec ${vmName} -- tar -C ${ENGINE_ROOT_IN_VM} -xf -`,
    );
    fs.removeSync(includesFile);

    const privateSrcPath = `${ENGINE_ROOT_ON_HOST}/engine-private`;
    if (fs.existsSync(privateSrcPath)) {
      const privateFiles = await new Promise((resolve, reject) =>
        walk(
          { path: privateSrcPath, ignoreFiles: ['.gitignore'], includeEmpty: false, follow: false },
          (err, result) => (err ? reject(err) : resolve(result)),
        ),
      );
      const privateIncludes = `/tmp/lxd-push-${vmName}-private-${Date.now()}.txt`;
      fs.writeFileSync(privateIncludes, privateFiles.join('\n'));
      shellExec(
        `lxc exec ${vmName} -- bash -c 'mkdir -p ${ENGINE_ROOT_IN_VM}/engine-private && find ${ENGINE_ROOT_IN_VM}/engine-private -mindepth 1 -delete'`,
      );
      shellExec(
        `tar -C ${privateSrcPath} -cf - --files-from=${privateIncludes} | lxc exec ${vmName} -- tar -C ${ENGINE_ROOT_IN_VM}/engine-private -xf -`,
      );
      fs.removeSync(privateIncludes);
    }

    logger.info(`  Engine source mirrored into ${vmName}:${ENGINE_ROOT_IN_VM}`);
  }
}

export default UnderpostLxd;
