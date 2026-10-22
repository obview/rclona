// 网盘字段中文词典：把 rclone 官方的英文配置项翻译成用户看得懂的说明。
// 每条分两层：brief（字段名后的一句短说明）+ detail（圆圈问号悬浮详解：这是什么、去哪找）。

// ---------- #2 网盘类型中文名 ----------
const TYPE_ZH = {
  s3: 'S3 / 对象存储',
  koofr: 'Koofr',
  webdav: 'WebDAV',
  local: '本地目录',
  drive: 'Google Drive（谷歌云端硬盘）',
  onedrive: 'OneDrive（微软云盘）',
  dropbox: 'Dropbox',
  'google cloud storage': 'Google Cloud Storage（谷歌云存储）',
  'google photos': 'Google Photos（谷歌相册）',
  azureblob: 'Azure Blob（微软云存储）',
  azurefiles: 'Azure Files（微软文件存储）',
  b2: 'Backblaze B2（云存储）',
  box: 'Box',
  pcloud: 'pCloud',
  mega: 'MEGA',
  yandex: 'Yandex Disk（俄罗斯网盘）',
  mailru: 'Mail.ru（俄罗斯云盘）',
  huaweidrive: '华为云盘',
  iclouddrive: 'iCloud Drive（苹果云盘）',
  protondrive: 'Proton Drive（加密网盘）',
  filen: 'Filen（加密网盘）',
  pikpak: 'PikPak',
  seafile: 'Seafile（开源私有云盘）',
  nextcloud: 'Nextcloud',
  ftp: 'FTP',
  sftp: 'SFTP（SSH 文件传输）',
  smb: 'SMB（局域网共享）',
  http: 'HTTP（只读网页目录）',
  storj: 'Storj（去中心化存储）',
  oracleobjectstorage: 'Oracle Object Storage（甲骨文对象存储）',
  qingstor: '青云 QingStor（对象存储）',
  swift: 'OpenStack Swift（对象存储）',
  crypt: 'Crypt（给其他网盘加一层加密）',
  alias: 'Alias（给已有网盘起别名）',
  memory: '内存盘（临时测试用）'
};
export function typeLabel(t) {
  return TYPE_ZH[t] || t;
}

// ---------- S3 服务商（provider 下拉的各个厂商）中文名 ----------
const S3_PROVIDER_ZH = {
  AWS: 'Amazon S3（亚马逊云存储）',
  Cloudflare: 'Cloudflare R2',
  Alibaba: '阿里云 OSS',
  TencentCOS: '腾讯云 COS',
  HuaweiOBS: '华为云 OBS',
  Qiniu: '七牛云 Kodo',
  ChinaMobile: '移动云 EOS',
  GCS: 'Google Cloud Storage（谷歌云存储）',
  IBMCOS: 'IBM Cloud COS（IBM 云对象存储）',
  Minio: 'Minio（自建对象存储）',
  Ceph: 'Ceph（自建对象存储）',
  DigitalOcean: 'DigitalOcean Spaces',
  Linode: 'Linode 对象存储',
  Wasabi: 'Wasabi',
  Storj: 'Storj',
  Synology: '群晖 C2 存储',
  Other: '其他 S3 兼容存储'
};
export function s3ProviderLabel(v) {
  return S3_PROVIDER_ZH[v] ? `${v} — ${S3_PROVIDER_ZH[v]}` : v;
}

// ---------- 按字段名的通用词典（所有类型通用） ----------
const GENERIC = {
  user: { brief: '账号 / 用户名', detail: '你在这个网盘的登录账号，一般是注册邮箱或用户名。' },
  username: { brief: '账号 / 用户名', detail: '你在这个网盘的登录账号，一般是注册邮箱或用户名。' },
  pass: { brief: '密码', detail: '很多网盘这里要填「应用专用密码」而不是登录密码（服务商出于安全要求）。在哪生成见该字段的服务商说明；不确定的话先填登录密码试一次，连接失败再改应用密码。' },
  password: { brief: '密码', detail: '很多网盘这里要填「应用专用密码」而不是登录密码（服务商出于安全要求）。在哪生成见该字段的服务商说明；不确定的话先填登录密码试一次，连接失败再改应用密码。' },
  host: { brief: '服务器地址', detail: '服务商给你的服务器地址（域名或 IP），在服务商的连接说明里能找到。' },
  hostname: { brief: '服务器地址', detail: '服务商给你的服务器地址（域名或 IP），在服务商的连接说明里能找到。' },
  port: { brief: '端口', detail: '一般保持默认即可，除非服务商特别给了你一个端口号。' },
  url: { brief: '服务地址', detail: '服务商给你的访问地址，以 http:// 或 https:// 开头，在服务商的设置/帮助里能找到。' },
  token: { brief: '访问令牌', detail: '一串用来证明身份的字符，在服务商的开发者设置或安全设置里生成。' },
  client_id: { brief: '应用 ID', detail: '在服务商的开发者平台创建一个「应用」后得到的 ID，和 client_secret 是一对。' },
  client_secret: { brief: '应用密钥', detail: '在服务商的开发者平台创建应用后得到的密钥，和 client_id 是一对，只显示一次要保存好。' },
  description: { brief: '备注（可留空）', detail: '给自己看的备注说明，填不填都不影响使用。' },
  encoding: { brief: '文件名编码（保持默认）', detail: '处理特殊文件名的规则，一般保持默认，改错了可能出现乱码或同步异常。' }
};

// ---------- 各类型的专属词典 ----------
const BY_TYPE = {
  s3: {
    provider: {
      brief: '服务商（你这家对象存储是谁家的）',
      detail: '在下面选你这家存储的厂商：Cloudflare R2 选「Cloudflare」，亚马逊选「AWS」，阿里云 OSS 选「Alibaba」，腾讯云 COS 选「TencentCOS」。选对了，下面的区域、接入点等选项会自动按这家来。如果选了 Cloudflare，上面的「快捷预设」按钮也能一键选好。'
    },
    env_auth: {
      brief: '从运行环境读取密钥（一般选「否」）',
      detail: '选「是」时，rclone 会去读服务器环境变量或云主机元数据里的 AWS 密钥，而不是用下面填的。我们都是自己填密钥，保持「否」即可。'
    },
    access_key_id: {
      brief: '访问密钥 ID',
      detail: '和下面的 secret_access_key 是一对「钥匙」，在服务商控制台创建：\n· Cloudflare R2：控制台 → R2 对象存储 →「管理 R2 API 令牌」→ 创建令牌（权限选「对象读和写」），创建后会显示 Access Key ID 与 Secret Access Key，只显示一次，当场复制保存。\n· 亚马逊 S3：AWS 控制台 → IAM → 用户 → 安全凭证 → 创建访问密钥。\n· 阿里云/腾讯云：在各自控制台的「访问密钥管理」里创建。'
    },
    secret_access_key: {
      brief: '访问密钥（和 ID 成对，相当于密码）',
      detail: '创建访问密钥时和 Access Key ID 一起生成的那串长字符，只在创建时显示一次。如果丢了，只能删掉旧令牌重新创建一个。获取路径见 access_key_id 的说明。填错这里是最常见的连接失败原因。'
    },
    region: {
      brief: '区域（存储桶在哪个地区）',
      detail: '你的桶创建在哪个区域就填哪个，如 us-east-1、ap-southeast-1。在服务商控制台的桶列表里能看到每个桶的区域。\n· Cloudflare R2：留空，或填 auto，都可以。\n· 亚马逊 S3：必填，和桶的实际区域一致。'
    },
    endpoint: {
      brief: '接入点地址（亚马逊 S3 以外都要填）',
      detail: '服务商给你的 S3 接口地址：\n· Cloudflare R2：填 https://<你的账户ID>.r2.cloudflarestorage.com，账户 ID 在 Cloudflare 控制台右侧栏或 R2 概览页能看到（就是网址里那串 32 位字符）。\n· 阿里云 OSS：形如 oss-cn-hangzhou.aliyuncs.com，在 OSS 控制台桶的「概览 → 访问域名」里查。\n· 亚马逊 S3：留空不用填。'
    },
    location_constraint: {
      brief: '位置约束（一般留空或与区域一致）',
      detail: '多数服务商留空即可；个别服务商（如亚马逊）要求它与区域（region）填一样的值。连接时如果报 location 相关错误，再回来把它改成和区域相同。'
    },
    acl: {
      brief: '新文件的默认访问权限',
      detail: '决定新存进去的文件谁能看。一般选 private（私有，只有你能访问）。千万别选 public-read（任何人可读），备份文件会泄露。'
    },
    storage_class: {
      brief: '存储类型（一般留空）',
      detail: '留空就是标准存储，存取最快。GLACIER（冰川）之类是便宜但取回很慢的归档存储，日常备份用不到，别乱选。'
    },
    server_side_encryption: {
      brief: '服务端加密（一般留空）',
      detail: '让服务商在存文件时自动加密。一般留空即可；选 AES256 是服务商托管加密，aws:kms 需要再填下面的 KMS 密钥 ID。'
    },
    sse_kms_key_id: {
      brief: 'KMS 密钥 ID（一般留空）',
      detail: '只有上面加密方式选了 aws:kms 时才需要填，是你在亚马逊 KMS 服务里创建的密钥编号。用不到就留空。'
    },
    bucket_object_lock_enabled: {
      brief: '给新建的桶开对象锁（一般选「否」）',
      detail: '开启后，桶里的文件在锁定期内谁都删不掉。镜像备份需要能删掉目标里的旧文件，开了它可能导致备份失败，保持关闭。'
    },
    ibm_api_key: { brief: 'IBM 的 API 密钥', detail: '只有用 IBM Cloud 对象存储时才填，在 IBM Cloud 控制台「管理 → 访问(IAM) → API 密钥」里创建。其他服务商留空。' },
    ibm_resource_instance_id: { brief: 'IBM 资源实例 ID', detail: '只有用 IBM Cloud 对象存储时才填，在该存储实例的详情页能看到。其他服务商留空。' }
  },
  koofr: {
    provider: {
      brief: '服务商',
      detail: '就是用 Koofr 本人就选「koofr」；Digi Storage 选「digistorage」；其他兼容 Koofr 协议的服务选「other」并填下面的 endpoint。'
    },
    user: {
      brief: '账号（Koofr 登录邮箱）',
      detail: '你在 koofr.eu 注册时用的邮箱地址。'
    },
    password: {
      brief: '应用专用密码（不是登录密码！）',
      detail: '不要填 Koofr 的登录密码，要填「应用专用密码」：登录 koofr.eu → 点右上角头像 → Settings（设置）→ Security（安全）→ App passwords（应用密码）→ 输入名字（比如 rclona）生成，把生成的那串密码填到这里。'
    },
    endpoint: {
      brief: '服务地址（provider 选 other 时才填）',
      detail: 'provider 选了 other 时才需要，是对方服务给你的接口地址。用 Koofr 本人（选 koofr）时留空。'
    },
    mountid: { brief: '挂载点 ID（一般留空）', detail: '高级选项，普通使用留空即可，rclone 会自动使用主存储。' },
    setmtime: { brief: '同步文件修改时间（保持默认）', detail: '让目标文件带上和源一样的修改时间。保持默认「是」即可。' }
  },
  webdav: {
    url: {
      brief: 'WebDAV 地址',
      detail: '服务商给你的 WebDAV 专用地址，常见几个：\n· 坚果云：https://dav.jianguoyun.com/dav/\n· Nextcloud：打开网页版 → 左下角「设置」里能看到 WebDAV 地址，形如 https://你的域名/remote.php/dav/files/用户名/\n· 其他服务在它的设置/帮助里找「WebDAV 地址」。'
    },
    vendor: {
      brief: '服务类型',
      detail: '你这家 WebDAV 是谁家的就选谁（Nextcloud 选 nextcloud、ownCloud 选 owncloud），rclone 会针对它微调行为；不确定就选 other，一般也能用。'
    },
    user: {
      brief: '账号',
      detail: '登录这个服务的账号，一般是邮箱或用户名。坚果云填账号邮箱。'
    },
    pass: {
      brief: '密码 / 应用密码',
      detail: '很多服务要求填「应用专用密码」而不是登录密码：\n· 坚果云：网页版 → 账户信息 → 安全选项 → 应用密码 → 添加。\n· Nextcloud：设置 → 安全 → 设备与会话 → 创建应用密码。\n生成后把那串密码填到这里。'
    },
    bearer_token: { brief: 'Bearer 令牌（一般留空）', detail: '少数服务用令牌而不是账号密码登录时才填，普通用户留空。' },
    bearer_token_command: { brief: '获取令牌的命令（一般留空）', detail: '高级选项，普通用户留空。' }
  },
  local: {}
};

// Cloudflare R2 预设下，几个关键字段用 R2 专用详解覆盖
const S3_R2_OVERRIDE = {
  access_key_id: {
    brief: '访问密钥 ID（R2 令牌的一半）',
    detail: '在 Cloudflare 控制台 → R2 对象存储 →「管理 R2 API 令牌」→「创建 API 令牌」：权限选「对象读和写」，范围可只勾你要备份的那个桶。创建后页面会显示 Access Key ID 和 Secret Access Key 两个值，只显示这一次，当场复制保存，关掉页面就再也看不到 Secret 了。'
  },
  secret_access_key: {
    brief: '访问密钥（R2 令牌的另一半）',
    detail: '创建 R2 API 令牌时和 Access Key ID 成对出现的那串长字符（见 access_key_id 的说明）。它只显示一次，丢了只能把旧令牌删掉重建一个。'
  },
  endpoint: {
    brief: 'R2 接入点地址',
    detail: '固定格式：https://<你的账户ID>.r2.cloudflarestorage.com 。账户 ID 在 Cloudflare 控制台首页右侧栏能看到，或者打开 R2 概览页看浏览器地址/页面里的「S3 API」地址，把里面的账户 ID 换进这个格式即可。'
  },
  region: {
    brief: '区域（R2 留空或填 auto）',
    detail: 'Cloudflare R2 不分区域，留空或填 auto 都可以，不用纠结。'
  }
};

// 查词典：返回 { brief, detail } 或 null（没收录）
export function fieldHelp(type, fieldName, providerValue) {
  if (type === 's3' && providerValue === 'Cloudflare' && S3_R2_OVERRIDE[fieldName]) {
    return S3_R2_OVERRIDE[fieldName];
  }
  return BY_TYPE[type]?.[fieldName] || GENERIC[fieldName] || null;
}
