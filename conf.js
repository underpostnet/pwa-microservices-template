const DefaultConf = {
  client: {
    default: {
      metadata: {
        title: 'Default',
        backgroundImage: './src/client/public/default/assets/background/white0-min.jpg',
      },
      components: {
        core: [
          'CommonJs',
          'VanillaJs',
          'Responsive',
          'Keyboard',
          'Translate',
          'Modal',
          'BtnIcon',
          'Logger',
          'Css',
          'NotificationManager',
          'ToggleSwitch',
          'DropDown',
          'LoadingAnimation',
          'EventsUI',
          'AgGrid',
          'Input',
          'Validator',
          'SignUp',
          'LogIn',
          'LogOut',
          'Router',
          'Account',
          'Auth',
          'FullScreen',
          'RichText',
          'Blog',
          'CalendarCore',
          'D3Chart',
          'Stream',
          'SocketIo',
          'Docs',
          'Content',
          'FileExplorer',
          'Chat',
          'Worker',
          'CssCore',
          'Wallet',
          'Badge',
          'ToolTip',
          'Webhook',
          'Recover',
        ],
        default: [
          'MenuDefault',
          'RoutesDefault',
          'ElementsDefault',
          'CommonDefault',
          'CssDefault',
          'LogInDefault',
          'LogOutDefault',
          'SignUpDefault',
          'TranslateDefault',
          'SettingsDefault',
          'SocketIoDefault',
        ],
      },
      views: [
        {
          path: '/',
          title: 'Home',
          client: 'Default',
          ssr: 'Default',
        },
        {
          path: '/home',
          title: 'Home',
          client: 'Default',
          ssr: 'Default',
        },
        {
          path: '/settings',
          client: 'Default',
          ssr: 'Default',
        },
        {
          path: '/log-in',
          client: 'Default',
          ssr: 'Default',
        },
        {
          path: '/sign-up',
          client: 'Default',
          ssr: 'Default',
        },
        {
          path: '/log-out',
          client: 'Default',
          ssr: 'Default',
        },
        {
          path: '/account',
          client: 'Default',
          ssr: 'Default',
        },
        {
          path: '/docs',
          client: 'Default',
          ssr: 'Default',
        },
        {
          path: '/recover',
          client: 'Default',
          ssr: 'Default',
        },
        {
          path: '/default-management',
          client: 'Default',
          ssr: 'Default',
        },
      ],
      dists: [
        {
          folder: './node_modules/@neodrag/vanilla/dist/min',
          public_folder: '/dist/@neodrag-vanilla',
          import_name: '@neodrag/vanilla',
          import_name_build: '/dist/@neodrag-vanilla/index.js',
        },
        {
          folder: './node_modules/@fortawesome/fontawesome-free',
          public_folder: '/dist/fontawesome',
        },
        {
          folder: './node_modules/sortablejs/modular',
          public_folder: '/dist/sortablejs',
          import_name: 'sortablejs',
          import_name_build: '/dist/sortablejs/sortable.complete.esm.js',
        },
        {
          folder: './node_modules/validator',
          public_folder: '/dist/validator',
        },
        {
          folder: './node_modules/@loadingio/css-spinner/entries',
          public_folder: '/dist/loadingio',
        },
        {
          import_name: 'ag-grid-community',
          import_name_build: '/dist/ag-grid-community/ag-grid-community.auto.complete.esm.min.js',
          folder: './node_modules/ag-grid-community/dist',
          public_folder: '/dist/ag-grid-community',
          styles: './node_modules/ag-grid-community/styles',
          public_styles_folder: '/styles/ag-grid-community',
        },
        {
          folder: './node_modules/socket.io/client-dist',
          public_folder: '/dist/socket.io',
          import_name: 'socket.io/client-dist/socket.io.esm.min.js',
          import_name_build: '/dist/socket.io/socket.io.esm.min.js',
        },
        {
          folder: './node_modules/peerjs/dist',
          public_folder: '/dist/peerjs',
        },
      ],
      services: ['default', 'core', 'user', 'test', 'file'],
    },
  },
  ssr: {
    Default: {
      head: ['PwaDefault', 'Css', 'DefaultScripts'],
      body: ['CacheControl', 'DefaultSplashScreen'],
    },
  },
  server: {
    'default.net': {
      '/': {
        client: 'default',
        runtime: 'nodejs',
        apis: ['default', 'core', 'user', 'test', 'file'],
        origins: [],
        minifyBuild: false,
        iconsBuild: true,
        lightBuild: false,
        docsBuild: false,
        ws: 'core',
        peer: true,
        proxy: [80, 443],
        db: {
          provider: 'mongoose',
          host: 'mongodb://127.0.0.1:27017',
          name: 'default',
        },
        mailer: {
          sender: {
            email: 'noreply@default.net',
            name: 'Default',
          },
          transport: {
            host: 'smtp.default.com',
            port: 465,
            secure: true,
            auth: {
              user: 'noreply@default.net',
              pass: '',
            },
          },
          templates: {
            userVerifyEmail: 'DefaultVerifyEmail',
            userRecoverEmail: 'DefaultRecoverEmail',
          },
        },
      },
    },
    'www.default.net': {
      '/': {
        client: null,
        runtime: 'nodejs',
        apis: [],
        origins: [],
        minifyBuild: false,
        lightBuild: true,
        proxy: [80, 443],
      },
    },
  },
  dns: {
    ipDaemon: {
      ip: null,
      minutesTimeInterval: 3,
      disabled: false,
    },
    records: {
      A: [
        {
          host: 'example.com',
          dns: 'dondominio',
          api_key: '???',
          user: '???',
        },
      ],
    },
  },
};

export { DefaultConf };