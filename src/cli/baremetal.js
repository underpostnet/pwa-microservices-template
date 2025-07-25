import { getNpmRootPath, getUnderpostRootPath } from '../server/conf.js';
import { pbcopy, shellExec } from '../server/process.js';
import dotenv from 'dotenv';
import { loggerFactory } from '../server/logger.js';
import { getLocalIPv4Address } from '../server/dns.js';
import fs from 'fs-extra';
import { Downloader } from '../server/downloader.js';

const logger = loggerFactory(import.meta);

/**
 * @class UnderpostBaremetal
 * @description Manages baremetal provisioning and configuration tasks.
 * This class provides a set of static methods to automate various
 * infrastructure operations, including NFS management, control server setup,
 * and system provisioning for different architectures.
 */
class UnderpostBaremetal {
  static API = {
    /**
     * @method callback
     * @description Initiates a baremetal provisioning workflow based on the provided options.
     * This is the primary entry point for orchestrating baremetal operations.
     * It handles NFS root filesystem building, control server installation/uninstallation,
     * and system-level provisioning tasks like timezone and keyboard configuration.
     * @param {string} [workflowId='rpi4mb'] - Identifier for the specific workflow configuration to use.
     * @param {string} [hostname=workflowId] - The hostname of the target baremetal machine.
     * @param {string} [ipAddress=getLocalIPv4Address()] - The IP address of the control server or the local machine.
     * @param {object} [options] - An object containing boolean flags for various operations.
     * @param {boolean} [options.dev=false] - Development mode flag.
     * @param {boolean} [options.controlServerInstall=false] - Flag to install the control server (e.g., MAAS).
     * @param {boolean} [options.controlServerUninstall=false] - Flag to uninstall the control server.
     * @param {boolean} [options.controlServerDbInstall=false] - Flag to install the control server's database.
     * @param {boolean} [options.controlServerDbUninstall=false] - Flag to uninstall the control server's database.
     * @param {boolean} [options.commission=false] - Flag to commission the baremetal machine.
     * @param {boolean} [options.nfsBuild=false] - Flag to build the NFS root filesystem.
     * @param {boolean} [options.nfsMount=false] - Flag to mount the NFS root filesystem.
     * @param {boolean} [options.nfsUnmount=false] - Flag to unmount the NFS root filesystem.
     * @param {boolean} [options.nfsSh=false] - Flag to chroot into the NFS environment for shell access.
     * @returns {void}
     */
    async callback(
      workflowId,
      hostname,
      ipAddress,
      options = {
        dev: false,
        controlServerInstall: false,
        controlServerUninstall: false,
        controlServerDbInstall: false,
        controlServerDbUninstall: false,
        commission: false,
        nfsBuild: false,
        nfsMount: false,
        nfsUnmount: false,
        nfsSh: false,
      },
    ) {
      // Load environment variables from .env file, overriding existing ones if present.
      dotenv.config({ path: `${getUnderpostRootPath()}/.env`, override: true });

      // Determine the root path for npm and underpost.
      const npmRoot = getNpmRootPath();
      const underpostRoot = options?.dev === true ? '.' : `${npmRoot}/underpost`;

      // Set default values if not provided.
      workflowId = workflowId ?? 'rpi4mb';
      hostname = hostname ?? workflowId;
      ipAddress = ipAddress ?? '192.168.1.192';

      // Set default MAC address
      let macAddress = '00:00:00:00:00:00';

      // Define the database provider ID.
      const dbProviderId = 'postgresql-17';

      // Define the NFS host path based on the environment variable and hostname.
      const nfsHostPath = `${process.env.NFS_EXPORT_PATH}/${hostname}`;

      // Define the TFTP root path based on the environment variable and hostname.
      const tftpRootPath = `${process.env.TFTP_ROOT}/${hostname}`;

      // Capture metadata for the callback execution, useful for logging and auditing.
      const callbackMetaData = {
        args: { hostname, ipAddress, workflowId },
        options,
        runnerHost: { architecture: UnderpostBaremetal.API.getHostArch(), ip: getLocalIPv4Address() },
        nfsHostPath,
        tftpRootPath,
      };

      // Log the initiation of the baremetal callback with relevant metadata.
      logger.info('Baremetal callback', callbackMetaData);

      // Handle NFS shell access option.
      if (options.nfsSh === true) {
        // Copy the chroot command to the clipboard for easy execution.
        pbcopy(`sudo chroot ${nfsHostPath} /usr/bin/qemu-aarch64-static /bin/bash`);
        return; // Exit early as this is a specific interactive operation.
      }

      // Handle control server installation.
      if (options.controlServerInstall === true) {
        // Ensure scripts are executable and then run them.
        shellExec(`chmod +x ${underpostRoot}/manifests/maas/maas-setup.sh`);
        shellExec(`chmod +x ${underpostRoot}/manifests/maas/nat-iptables.sh`);
        shellExec(`${underpostRoot}/manifests/maas/maas-setup.sh`);
        shellExec(`${underpostRoot}/manifests/maas/nat-iptables.sh`);
      }

      // Handle control server uninstallation.
      if (options.controlServerUninstall === true) {
        // Stop and remove MAAS services, handling potential errors gracefully.
        shellExec(`sudo snap stop maas.pebble || true`);
        shellExec(`sudo snap stop maas`);
        shellExec(`sudo snap remove maas --purge || true`);

        // Remove residual snap data to ensure a clean uninstall.
        shellExec(`sudo rm -rf /var/snap/maas`);
        shellExec(`sudo rm -rf ~/snap/maas`);

        // Remove MAAS configuration and data directories.
        shellExec(`sudo rm -rf /etc/maas`);
        shellExec(`sudo rm -rf /var/lib/maas`);
        shellExec(`sudo rm -rf /var/log/maas`);
      }

      // Handle control server database installation.
      if (options.controlServerDbInstall === true) {
        // Deploy the database provider and manage MAAS database.
        shellExec(`node ${underpostRoot}/bin/deploy ${dbProviderId} install`);
        shellExec(
          `node ${underpostRoot}/bin/deploy pg-drop-db ${process.env.DB_PG_MAAS_NAME} ${process.env.DB_PG_MAAS_USER}`,
        );
        shellExec(`node ${underpostRoot}/bin/deploy maas db`);
      }

      // Handle control server database uninstallation.
      if (options.controlServerDbUninstall === true) {
        shellExec(`node ${underpostRoot}/bin/deploy ${dbProviderId} uninstall`);
      }

      // Handle NFS mount operation.
      if (options.nfsMount === true) {
        UnderpostBaremetal.API.nfsMountCallback({ hostname, workflowId, mount: true });
      }

      // Handle NFS unmount operation.
      if (options.nfsUnmount === true) {
        UnderpostBaremetal.API.nfsMountCallback({ hostname, workflowId, unmount: true });
      }

      // Handle NFS root filesystem build operation.
      if (options.nfsBuild === true) {
        // Check if NFS is already mounted to avoid redundant builds.
        const { isMounted } = UnderpostBaremetal.API.nfsMountCallback({ hostname, workflowId });
        if (isMounted) {
          logger.warn('NFS root filesystem is mounted, skipping build.');
          return; // Exit if already mounted.
        }
        logger.info('NFS root filesystem is not mounted, building...');

        // Install necessary packages for debootstrap and QEMU.
        shellExec(`sudo dnf install -y iptables-legacy`);
        shellExec(`sudo dnf install -y debootstrap`);
        shellExec(`sudo dnf install kernel-modules-extra-$(uname -r)`);
        // Reset QEMU user-static binfmt for proper cross-architecture execution.
        shellExec(`sudo podman run --rm --privileged multiarch/qemu-user-static --reset -p yes`);
        shellExec(`sudo modprobe binfmt_misc`);
        shellExec(`sudo mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc`);

        // Clean and create the NFS host path.
        shellExec(`sudo rm -rf ${nfsHostPath}/*`);
        shellExec(`mkdir -p ${nfsHostPath}`);
        shellExec(`sudo chown -R root:root ${nfsHostPath}`);
        shellExec(`sudo chmod 755 ${nfsHostPath}`);

        let debootstrapArch;

        // Perform the first stage of debootstrap.
        {
          const { architecture, name } = UnderpostBaremetal.API.workflowsConfig[workflowId].debootstrap.image;
          debootstrapArch = architecture;
          shellExec(
            [
              `sudo debootstrap`,
              `--arch=${architecture}`,
              `--variant=minbase`,
              `--foreign`, // Indicates a two-stage debootstrap.
              name,
              nfsHostPath,
              `http://ports.ubuntu.com/ubuntu-ports/`,
            ].join(' '),
          );
        }

        // Create a podman container to extract QEMU static binaries.
        shellExec(`sudo podman create --name extract multiarch/qemu-user-static`);
        shellExec(`podman ps -a`); // List all podman containers for verification.

        // If cross-architecture, copy the QEMU static binary into the chroot.
        if (debootstrapArch !== callbackMetaData.runnerHost.architecture)
          UnderpostBaremetal.API.crossArchBinFactory({
            nfsHostPath,
            debootstrapArch,
          });

        // Clean up the temporary podman container.
        shellExec(`sudo podman rm extract`);
        shellExec(`podman ps -a`);
        shellExec(`file ${nfsHostPath}/bin/bash`); // Verify the bash executable in the chroot.

        // Perform the second stage of debootstrap within the chroot environment.
        UnderpostBaremetal.API.crossArchRunner({
          nfsHostPath,
          debootstrapArch,
          callbackMetaData,
          steps: [`/debootstrap/debootstrap --second-stage`],
        });

        // Mount NFS if it's not already mounted after the build.
        if (!isMounted) {
          UnderpostBaremetal.API.nfsMountCallback({ hostname, workflowId, mount: true });
        }

        // Apply system provisioning steps (base, user, timezone, keyboard).
        {
          const { systemProvisioning, kernelLibVersion, chronyc } = UnderpostBaremetal.API.workflowsConfig[workflowId];
          const { timezone, chronyConfPath } = chronyc;

          UnderpostBaremetal.API.crossArchRunner({
            nfsHostPath,
            debootstrapArch,
            callbackMetaData,
            steps: [
              ...UnderpostBaremetal.API.systemProvisioningFactory[systemProvisioning].base({
                kernelLibVersion,
              }),
              ...UnderpostBaremetal.API.systemProvisioningFactory[systemProvisioning].user(),
              ...UnderpostBaremetal.API.systemProvisioningFactory[systemProvisioning].timezone({
                timezone,
                chronyConfPath,
              }),
              ...UnderpostBaremetal.API.systemProvisioningFactory[systemProvisioning].keyboard(),
            ],
          });
        }
      }

      let resources, resource, machines;

      if (options.commission === true || options.ls === true) {
        resources = JSON.parse(
          shellExec(`maas ${process.env.MAAS_ADMIN_USERNAME} boot-resources read`, {
            silent: true,
            stdout: true,
          }),
        ).map((o) => ({
          id: o.id,
          name: o.name,
          architecture: o.architecture,
        }));
        if (options.ls === true) {
          console.table(resources);
        }
        machines = JSON.parse(
          shellExec(`maas ${process.env.MAAS_ADMIN_USERNAME} machines read`, {
            stdout: true,
            silent: true,
          }),
        ).map((m) => ({
          system_id: m.interface_set[0].system_id,
          mac_address: m.interface_set[0].mac_address,
          hostname: m.hostname,
          status_name: m.status_name,
        }));
        if (options.ls === true) {
          console.table(machines);
        }
      }

      // Handle commissioning tasks (placeholder for future implementation).
      if (options.commission === true) {
        const { firmwares, networkInterfaceName, maas, netmask, menuentryStr } =
          UnderpostBaremetal.API.workflowsConfig[workflowId];
        resource = resources.find((o) => o.architecture === maas.image.architecture && o.name === maas.image.name);
        logger.info('Commissioning resource', resource);

        shellExec(`sudo rm -rf ${tftpRootPath}`);
        shellExec(`mkdir -p ${tftpRootPath}/pxe`);

        for (const firmware of firmwares) {
          const { url, gateway, subnet } = firmware;
          if (url.match('.zip')) {
            const name = url.split('/').pop().replace('.zip', '');
            const path = `../${name}`;
            if (!fs.existsSync(path)) {
              await Downloader(url, `../${name}.zip`);
              shellExec(`cd .. && mkdir ${name} && cd ${name} && unzip ../${name}.zip`);
            }
            shellExec(`sudo cp -a ${path}/* ${tftpRootPath}`);

            if (gateway && subnet) {
              fs.writeFileSync(
                `${tftpRootPath}/boot_${name}.conf`,
                UnderpostBaremetal.API.bootConfFactory({
                  workflowId,
                  tftpIp: callbackMetaData.runnerHost.ip,
                  tftpPrefixStr: hostname,
                  macAddress,
                  clientIp: ipAddress,
                  subnet,
                  gateway,
                }),
                'utf8',
              );
            }
          }
        }

        UnderpostBaremetal.API.rebuildNfsServer({
          nfsHostPath,
        });

        {
          const resourceData = JSON.parse(
            shellExec(`maas ${process.env.MAAS_ADMIN_USERNAME} boot-resource read ${resource.id}`, {
              stdout: true,
              silent: true,
              disableLog: true,
            }),
          );
          const bootFiles = resourceData.sets[Object.keys(resourceData.sets)[0]].files;
          const suffix = resource.architecture.match('xgene') ? '.xgene' : '';
          const resourcesPath = `/var/snap/maas/common/maas/image-storage/bootloaders/uefi/arm64`;
          const kernelPath = `/var/snap/maas/common/maas/image-storage`;
          const kernelFilesPaths = {
            'vmlinuz-efi': `${kernelPath}/${bootFiles['boot-kernel' + suffix].filename_on_disk}`,
            'initrd.img': `${kernelPath}/${bootFiles['boot-initrd' + suffix].filename_on_disk}`,
            squashfs: `${kernelPath}/${bootFiles['squashfs'].filename_on_disk}`,
          };
          const cmd = [
            `console=serial0,115200`,
            // `console=ttyAMA0,115200`,
            `console=tty1`,
            // `initrd=-1`,
            // `net.ifnames=0`,
            // `dwc_otg.lpm_enable=0`,
            // `elevator=deadline`,
            `root=/dev/nfs`,
            `nfsroot=${callbackMetaData.runnerHost.ip}:${process.env.NFS_EXPORT_PATH}/rpi4mb,${[
              'tcp',
              'vers=3',
              'nfsvers=3',
              'nolock',
              // 'protocol=tcp',
              // 'hard=true',
              'port=2049',
              // 'sec=none',
              'rw',
              'hard',
              'intr',
              'rsize=32768',
              'wsize=32768',
              'acregmin=0',
              'acregmax=0',
              'acdirmin=0',
              'acdirmax=0',
              'noac',
              // 'nodev',
              // 'nosuid',
            ]}`,
            `ip=${ipAddress}:${callbackMetaData.runnerHost.ip}:${callbackMetaData.runnerHost.ip}:${netmask}:${hostname}:${networkInterfaceName}:static`,
            `rootfstype=nfs`,
            `rw`,
            `rootwait`,
            `fixrtc`,
            'initrd=initrd.img',
            // 'boot=casper',
            // 'ro',
            'netboot=nfs',
            `init=/sbin/init`,
            // `cloud-config-url=/dev/null`,
            // 'ip=dhcp',
            // 'ip=dfcp',
            // 'autoinstall',
            // 'rd.break',

            // Disable services that not apply over nfs
            `systemd.mask=systemd-network-generator.service`,
            `systemd.mask=systemd-networkd.service`,
            `systemd.mask=systemd-fsck-root.service`,
            `systemd.mask=systemd-udev-trigger.service`,
          ];
          const nfsConnectStr = cmd.join(' ');

          for (const file of ['bootaa64.efi', 'grubaa64.efi']) {
            shellExec(`sudo cp -a ${resourcesPath}/${file} ${tftpRootPath}/pxe/${file}`);
          }
          for (const file of Object.keys(kernelFilesPaths)) {
            shellExec(`sudo cp -a ${kernelFilesPaths[file]} ${tftpRootPath}/pxe/${file}`);
          }

          fs.writeFileSync(
            `${process.env.TFTP_ROOT}/grub/grub.cfg`,
            `
insmod gzio
insmod http
insmod nfs
set timeout=5
set default=0

menuentry '${menuentryStr}' {
  set root=(tftp,${callbackMetaData.runnerHost.ip})
  linux /${hostname}/pxe/vmlinuz-efi ${nfsConnectStr}
  initrd /${hostname}/pxe/initrd.img
  boot
}

    `,
            'utf8',
          );
        }

        const arm64EfiPath = `${process.env.TFTP_ROOT}/grub/arm64-efi`;
        if (fs.existsSync(arm64EfiPath)) shellExec(`sudo rm -rf ${arm64EfiPath}`);
        shellExec(`sudo cp -a /usr/lib/grub/arm64-efi ${arm64EfiPath}`);

        shellExec(`sudo chown -R root:root ${process.env.TFTP_ROOT}`);
        shellExec(`sudo sudo chmod 755 ${process.env.TFTP_ROOT}`);
      }
    },

    /**
     * @method crossArchBinFactory
     * @description Copies the appropriate QEMU static binary into the NFS root filesystem
     * for cross-architecture execution within a chroot environment.
     * @param {object} params - The parameters for the function.
     * @param {string} params.nfsHostPath - The path to the NFS root filesystem on the host.
     * @param {'arm64'|'amd64'} params.debootstrapArch - The target architecture of the debootstrap environment.
     * @returns {void}
     */
    crossArchBinFactory({ nfsHostPath, debootstrapArch }) {
      switch (debootstrapArch) {
        case 'arm64':
          // Copy QEMU static binary for ARM64.
          shellExec(`sudo podman cp extract:/usr/bin/qemu-aarch64-static ${nfsHostPath}/usr/bin/`);
          break;
        case 'amd64':
          // Copy QEMU static binary for AMD64.
          shellExec(`sudo podman cp extract:/usr/bin/qemu-x86_64-static ${nfsHostPath}/usr/bin/`);
          break;
        default:
          // Log a warning or throw an error for unsupported architectures.
          logger.warn(`Unsupported debootstrap architecture: ${debootstrapArch}`);
          break;
      }
      shellExec(`sudo dnf install grub2-efi-aa64-modules`);
      shellExec(`sudo dnf install grub2-efi-x64-modules`);
    },

    /**
     * @method crossArchRunner
     * @description Executes a series of shell commands within a chroot environment,
     * optionally using QEMU for cross-architecture execution.
     * @param {object} params - The parameters for the function.
     * @param {string} params.nfsHostPath - The path to the NFS root filesystem on the host.
     * @param {'arm64'|'amd64'} params.debootstrapArch - The target architecture of the debootstrap environment.
     * @param {object} params.callbackMetaData - Metadata about the callback, including runner host architecture.
     * @param {string[]} params.steps - An array of shell commands to execute.
     * @returns {void}
     */
    crossArchRunner({ nfsHostPath, debootstrapArch, callbackMetaData, steps }) {
      // Render the steps with logging for better visibility during execution.
      steps = UnderpostBaremetal.API.stepsRender(steps, false);

      let qemuCrossArchBash = '';
      // Determine if QEMU is needed for cross-architecture execution.
      if (debootstrapArch !== callbackMetaData.runnerHost.architecture)
        switch (debootstrapArch) {
          case 'arm64':
            qemuCrossArchBash = '/usr/bin/qemu-aarch64-static ';
            break;
          case 'amd64':
            qemuCrossArchBash = '/usr/bin/qemu-x86_64-static ';
            break;
          default:
            // No QEMU prefix for unsupported or native architectures.
            break;
        }

      // Execute the commands within the chroot environment using a heredoc.
      shellExec(`sudo chroot ${nfsHostPath} ${qemuCrossArchBash}/bin/bash <<'EOF'
${steps}
EOF`);
    },

    /**
     * @method stepsRender
     * @description Renders an array of shell commands into a formatted string,
     * optionally including YAML-style formatting and execution logging.
     * This helps in visualizing and debugging the execution flow of provisioning steps.
     * @param {string[]} [steps=[]] - An array of shell commands.
     * @param {boolean} [yaml=true] - If true, formats the output as YAML list items.
     * @returns {string} The formatted string of commands.
     */
    stepsRender(steps = [], yaml = true) {
      return steps
        .map(
          (step, i, a) =>
            // Add a timestamp and step counter for better logging and traceability.
            (yaml ? '  - ' : '') +
            'echo "' +
            (yaml ? '\\' : '') +
            '$(date) | ' +
            (i + 1) +
            '/' +
            a.length +
            ' - ' +
            step.split('\n')[0] +
            '"' +
            `\n` +
            `${yaml ? '  - ' : ''}${step}`,
        )
        .join('\n'); // Join all steps with newlines.
    },

    /**
     * @method nfsMountCallback
     * @description Manages NFS mounts and unmounts for the baremetal provisioning process.
     * It checks the mount status and performs mount/unmount operations as requested.
     * @param {object} params - The parameters for the function.
     * @param {string} params.hostname - The hostname of the target machine.
     * @param {string} params.workflowId - The identifier for the workflow configuration.
     * @param {boolean} [params.mount] - If true, attempts to mount the NFS paths.
     * @param {boolean} [params.unmount] - If true, attempts to unmount the NFS paths.
     * @returns {{isMounted: boolean}} An object indicating whether any NFS path is currently mounted.
     */
    nfsMountCallback({ hostname, workflowId, mount, unmount }) {
      let isMounted = false;
      // Iterate through defined NFS mounts in the workflow configuration.
      for (const mountCmd of Object.keys(UnderpostBaremetal.API.workflowsConfig[workflowId].nfs.mounts)) {
        for (const mountPath of UnderpostBaremetal.API.workflowsConfig[workflowId].nfs.mounts[mountCmd]) {
          const hostMountPath = `${process.env.NFS_EXPORT_PATH}/${hostname}${mountPath}`;
          // Check if the path is already mounted.
          const isPathMounted = !shellExec(`mountpoint ${hostMountPath}`, { silent: true, stdout: true }).match(
            'not a mountpoint',
          );

          if (isPathMounted) {
            if (!isMounted) isMounted = true; // Set overall mounted status.
            logger.warn('Nfs path already mounted', mountPath);
            if (unmount === true) {
              // Unmount if requested.
              shellExec(`sudo umount ${hostMountPath}`);
            }
          } else {
            if (mount === true) {
              // Mount if requested and not already mounted.
              shellExec(`sudo mount --${mountCmd} ${mountPath} ${hostMountPath}`);
            } else {
              logger.warn('Nfs path not mounted', mountPath);
            }
          }
        }
      }
      return { isMounted };
    },

    /**
     * @method getHostArch
     * @description Determines the architecture of the host machine.
     * This is crucial for cross-compilation and selecting the correct QEMU binaries.
     * @returns {'amd64'|'arm64'} The host architecture.
     * @throws {Error} If the host architecture is unsupported.
     */
    getHostArch() {
      // `uname -m` returns e.g. 'x86_64' or 'aarch64'
      const machine = shellExec('uname -m', { stdout: true }).trim();
      if (machine === 'x86_64') return 'amd64';
      if (machine === 'aarch64') return 'arm64';
      throw new Error(`Unsupported host architecture: ${machine}`);
    },

    /**
     * @property {object} systemProvisioningFactory
     * @description A factory object containing functions for system provisioning based on OS type.
     * Each OS type (e.g., 'ubuntu') provides methods for base system setup, user creation,
     * timezone configuration, and keyboard layout settings.
     */
    systemProvisioningFactory: {
      /**
       * @property {object} ubuntu
       * @description Provisioning steps for Ubuntu-based systems.
       */
      ubuntu: {
        /**
         * @method base
         * @description Generates shell commands for basic Ubuntu system provisioning.
         * This includes updating package lists, installing essential build tools,
         * kernel modules, cloud-init, SSH server, and other core utilities.
         * @param {object} params - The parameters for the function.
         * @param {string} params.kernelLibVersion - The specific kernel library version to install.
         * @returns {string[]} An array of shell commands.
         */
        base: ({ kernelLibVersion }) => [
          // Configure APT sources for Ubuntu ports.
          `cat <<SOURCES | tee /etc/apt/sources.list
deb http://ports.ubuntu.com/ubuntu-ports noble main restricted universe multiverse
deb http://ports.ubuntu.com/ubuntu-ports noble-updates main restricted universe multiverse
deb http://ports.ubuntu.com/ubuntu-ports noble-security main restricted universe multiverse
SOURCES`,

          // Update package lists and perform a full system upgrade.
          `apt update -qq`,
          `apt -y full-upgrade`,
          // Install essential development and system utilities.
          `apt install -y build-essential xinput x11-xkb-utils usbutils`,
          'apt install -y linux-image-generic',
          // Install specific kernel modules.
          `apt install -y linux-modules-${kernelLibVersion} linux-modules-extra-${kernelLibVersion}`,

          `depmod -a ${kernelLibVersion}`, // Update kernel module dependencies.
          // Install cloud-init, systemd, SSH, sudo, locales, udev, and networking tools.
          `apt install -y cloud-init systemd-sysv openssh-server sudo locales udev util-linux systemd-sysv iproute2 netplan.io ca-certificates curl wget chrony`,
          `ln -sf /lib/systemd/systemd /sbin/init`, // Ensure systemd is the init system.

          `apt-get update`,
          `DEBIAN_FRONTEND=noninteractive apt-get install -y apt-utils`, // Install apt-utils non-interactively.
          `DEBIAN_FRONTEND=noninteractive apt-get install -y tzdata kmod keyboard-configuration console-setup iputils-ping`, // Install timezone data, kernel modules, and network tools.
        ],
        /**
         * @method user
         * @description Generates shell commands for creating a root user and configuring SSH access.
         * This is a critical security step for initial access to the provisioned system.
         * @returns {string[]} An array of shell commands.
         */
        user: () => [
          `useradd -m -s /bin/bash -G sudo root`, // Create a root user with bash shell and sudo privileges.
          `echo 'root:root' | chpasswd`, // Set a default password for the root user (consider more secure methods for production).
          `mkdir -p /home/root/.ssh`, // Create .ssh directory for authorized keys.
          // Add the public SSH key to authorized_keys for passwordless login.
          `echo '${fs.readFileSync(
            `/home/dd/engine/engine-private/deploy/id_rsa.pub`,
            'utf8',
          )}' > /home/root/.ssh/authorized_keys`,
          `chown -R root /home/root/.ssh`, // Set ownership for security.
          `chmod 700 /home/root/.ssh`, // Set permissions for the .ssh directory.
          `chmod 600 /home/root/.ssh/authorized_keys`, // Set permissions for authorized_keys.
        ],
        /**
         * @method timezone
         * @description Generates shell commands for configuring the system timezone and Chrony (NTP client).
         * Accurate time synchronization is essential for logging, security, and distributed systems.
         * @param {object} params - The parameters for the function.
         * @param {string} params.timezone - The timezone string (e.g., 'America/New_York').
         * @param {string} params.chronyConfPath - The path to the Chrony configuration file.
         * @param {string} [alias='chrony'] - The alias for the chrony service.
         * @returns {string[]} An array of shell commands.
         */
        timezone: ({ timezone, chronyConfPath }, alias = 'chrony') => [
          `export DEBIAN_FRONTEND=noninteractive`, // Set non-interactive mode for Debian packages.
          `ln -fs /usr/share/zoneinfo/${timezone} /etc/localtime`, // Symlink timezone.
          `sudo dpkg-reconfigure --frontend noninteractive tzdata`, // Reconfigure timezone data.

          // Write the Chrony configuration file.
          `echo '
# Use public servers from the pool.ntp.org project.
# Please consider joining the pool (http://www.pool.ntp.org/join.html).
# pool 2.pool.ntp.org iburst
server ${process.env.MAAS_NTP_SERVER} iburst

# Record the rate at which the system clock gains/losses time.
driftfile /var/lib/chrony/drift

# Allow the system clock to be stepped in the first three updates
# if its offset is larger than 1 second.
makestep 1.0 3

# Enable kernel synchronization of the real-time clock (RTC).
rtcsync

# Enable hardware timestamping on all interfaces that support it.
#hwtimestamp *

# Increase the minimum number of selectable sources required to adjust
# the system clock.
#minsources 2

# Allow NTP client access from local network.
#allow 192.168.0.0/16

# Serve time even if not synchronized to a time source.
#local stratum 10

# Specify file containing keys for NTP authentication.
keyfile /etc/chrony.keys

# Get TAI-UTC offset and leap seconds from the system tz database.
leapsectz right/UTC

# Specify directory for log files.
logdir /var/log/chrony

# Select which information is logged.
#log measurements statistics tracking
' > ${chronyConfPath}`,
          `systemctl stop ${alias}`, // Stop Chrony service before reconfiguring.

          // Enable, restart, and check status of Chrony service.
          `sudo systemctl enable --now ${alias}`,
          `sudo systemctl restart ${alias}`,
          `sudo systemctl status ${alias}`,

          // Verify Chrony synchronization.
          `chronyc sources`,
          `chronyc tracking`,

          `chronyc sourcestats -v`, // Display source statistics.
          `timedatectl status`, // Display current time and date settings.
        ],
        /**
         * @method keyboard
         * @description Generates shell commands for configuring the keyboard layout.
         * This ensures correct input behavior on the provisioned system.
         * @returns {string[]} An array of shell commands.
         */
        keyboard: () => [
          `sudo locale-gen en_US.UTF-8`, // Generate the specified locale.
          `sudo update-locale LANG=en_US.UTF-8`, // Update system locale.
          `sudo sed -i 's/XKBLAYOUT="us"/XKBLAYOUT="es"/' /etc/default/keyboard`, // Change keyboard layout to Spanish.
          `sudo dpkg-reconfigure --frontend noninteractive keyboard-configuration`, // Reconfigure keyboard non-interactively.
          `sudo systemctl restart keyboard-setup.service`, // Restart keyboard setup service.
        ],
      },
    },

    rebuildNfsServer({ nfsHostPath, subnet }) {
      if (!subnet) subnet = '192.168.1.0/24';
      fs.writeFileSync(
        `/etc/exports`,
        `${nfsHostPath} ${subnet}(${[
          'rw',
          // 'all_squash',
          'sync',
          'no_root_squash',
          'no_subtree_check',
          'insecure',
        ]})`,
        'utf8',
      );

      logger.info('Writing NFS server configuration to /etc/nfs.conf...');
      fs.writeFileSync(
        `/etc/nfs.conf`,
        `[mountd]
port = 20048

[statd]
port = 32765
outgoing-port = 32765

[nfsd]
# Enable RDMA support if desired and hardware supports it.
rdma=y
rdma-port=20049

[lockd]
port = 32766
udp-port = 32766
`,
        'utf8',
      );
      logger.info('NFS configuration written.');

      logger.info('Reloading NFS exports...');
      shellExec(`sudo exportfs -rav`);

      // Display the currently active NFS exports for verification.
      logger.info('Displaying active NFS exports:');
      shellExec(`sudo exportfs -s`);

      // Restart the nfs-server service to apply all configuration changes,
      // including port settings from /etc/nfs.conf and export changes.
      logger.info('Restarting nfs-server service...');
      shellExec(`sudo systemctl restart nfs-server`);
      logger.info('NFS server restarted.');
    },

    bootConfFactory({ workflowId, tftpIp, tftpPrefixStr, macAddress, clientIp, subnet, gateway }) {
      switch (workflowId) {
        case 'rpi4mb':
          return `[all]
BOOT_UART=0
WAKE_ON_GPIO=1
POWER_OFF_ON_HALT=0
ENABLE_SELF_UPDATE=1
DISABLE_HDMI=0
NET_INSTALL_ENABLED=1
DHCP_TIMEOUT=45000
DHCP_REQ_TIMEOUT=4000
TFTP_FILE_TIMEOUT=30000
BOOT_ORDER=0x21

# ─────────────────────────────────────────────────────────────
# TFTP configuration
# ─────────────────────────────────────────────────────────────

# Custom TFTP prefix string (e.g., based on MAC address, no colons)
#TFTP_PREFIX_STR=AA-BB-CC-DD-EE-FF/

# Optional PXE Option43 override (leave commented if unused)
#PXE_OPTION43="Raspberry Pi Boot"

# DHCP client GUID (Option 97); 0x34695052 is the FourCC for Raspberry Pi 4
#DHCP_OPTION97=0x34695052

TFTP_IP=${tftpIp}
TFTP_PREFIX=1
TFTP_PREFIX_STR=${tftpPrefixStr}/

# ─────────────────────────────────────────────────────────────
# Manually override Ethernet MAC address
# ─────────────────────────────────────────────────────────────

MAC_ADDRESS=${macAddress}

# OTP MAC address override
#MAC_ADDRESS_OTP=0,1

# ─────────────────────────────────────────────────────────────
# Static IP configuration (bypasses DHCP completely)
# ─────────────────────────────────────────────────────────────
CLIENT_IP=${clientIp}
SUBNET=${subnet}
GATEWAY=${gateway}`;

        default:
          throw new Error('Boot conf factory invalid workflow ID:' + workflowId);
      }
    },

    /**
     * @property {object} workflowsConfig
     * @description Configuration for different baremetal provisioning workflows.
     * Each workflow defines specific parameters like system provisioning type,
     * kernel version, Chrony settings, debootstrap image details, and NFS mounts.
     */
    workflowsConfig: {
      /**
       * @property {object} rpi4mb
       * @description Configuration for the Raspberry Pi 4 Model B workflow.
       */
      rpi4mb: {
        menuentryStr: 'UNDERPOST.NET UEFI/GRUB/MAAS RPi4 commissioning (ARM64)',
        systemProvisioning: 'ubuntu', // Specifies the system provisioning factory to use.
        kernelLibVersion: `6.8.0-41-generic`, // The kernel library version for this workflow.
        networkInterfaceName: 'enabcm6e4ei0',
        netmask: '255.255.255.0',
        firmwares: [
          {
            url: 'https://github.com/pftf/RPi4/releases/download/v1.41/RPi4_UEFI_Firmware_v1.41.zip',
            gateway: '192.168.1.1',
            subnet: '255.255.255.0',
          },
        ],
        chronyc: {
          timezone: 'America/New_York', // Timezone for Chrony configuration.
          chronyConfPath: `/etc/chrony/chrony.conf`, // Path to Chrony configuration file.
        },
        debootstrap: {
          image: {
            architecture: 'arm64', // Architecture for the debootstrap image.
            name: 'noble', // Codename of the Ubuntu release.
          },
        },
        maas: {
          image: {
            architecture: 'arm64/ga-24.04', // Architecture for MAAS image.
            name: 'ubuntu/noble', // Name of the MAAS Ubuntu image.
          },
        },
        nfs: {
          mounts: {
            // Define NFS mount points and their types (bind, rbind).
            bind: ['/proc', '/sys', '/run'],
            rbind: ['/dev'],
          },
        },
      },
    },
  };
}

export default UnderpostBaremetal;
