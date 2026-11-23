"""Сборка APK web-tabs без Android Studio и Gradle: aapt2 → javac → d8 → zipalign → apksigner.

python android/build.py            — собрать android/build/web-tabs.apk
python android/build.py install    — собрать и поставить на подключённое устройство/эмулятор (adb)

Пути к инструментам — переменные окружения или значения по умолчанию ниже:
  ANDROID_SDK  (sdk с build-tools/35.0.0 и platforms/android-35)
  JAVA_HOME    (JDK 17)
  WEBTABS_KEYSTORE (ключ подписи; создаётся при первой сборке — храните его, иначе обновления
                    на планшете придётся ставить с удалением приложения)
"""
import os, shutil, subprocess, sys, tempfile, zipfile, glob

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
EMU = os.path.join(os.path.expanduser('~'), 'Documents', 'AndroidEmulator')
SDK = os.environ.get('ANDROID_SDK') or os.path.join(EMU, 'sdk')
JDK = os.environ.get('JAVA_HOME') or next(iter(glob.glob(os.path.join(EMU, 'jdk', 'jdk-17*'))), '')
KEYSTORE = os.environ.get('WEBTABS_KEYSTORE') or os.path.join(EMU, 'keys', 'web-tabs.jks')
BT = os.path.join(SDK, 'build-tools', '35.0.0')
ANDROID_JAR = os.path.join(SDK, 'platforms', 'android-35', 'android.jar')
OUT = os.path.join(tempfile.gettempdir(), 'web-tabs-build')   # латинский путь: aapt2 не понимает кириллицу
DIST = os.path.join(HERE, 'build')
VERSION_NAME = '0.4.0'
VERSION_CODE = '4'


def tool(name):
    for ext in ('.exe', '.bat', ''):
        p = os.path.join(BT, name + ext)
        if os.path.exists(p):
            return p
    raise SystemExit(f'не найден {name} в {BT}')


def jdk(name):
    return os.path.join(JDK, 'bin', name + ('.exe' if os.name == 'nt' else ''))


def run(*cmd):
    env = dict(os.environ, JAVA_HOME=JDK, PATH=os.path.join(JDK, 'bin') + os.pathsep + os.environ.get('PATH', ''))
    r = subprocess.run([str(c) for c in cmd], capture_output=True, text=True, env=env)
    if r.returncode:
        print(r.stdout, r.stderr)
        raise SystemExit(f'ошибка: {os.path.basename(str(cmd[0]))}')
    return r.stdout


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(OUT)
    # исходники Android — тоже во временную папку (там путь без кириллицы)
    src_android = os.path.join(OUT, 'android')
    shutil.copytree(os.path.join(HERE, 'res'), os.path.join(src_android, 'res'))
    shutil.copytree(os.path.join(HERE, 'src'), os.path.join(src_android, 'src'))
    shutil.copy(os.path.join(HERE, 'AndroidManifest.xml'), src_android)

    # 1) веб-часть → assets/www (те же файлы, что на компьютере)
    www = os.path.join(OUT, 'assets', 'www')
    shutil.copytree(os.path.join(ROOT, 'src'), os.path.join(www, 'src'))
    shutil.copy(os.path.join(ROOT, 'index.html'), www)

    # 2) ресурсы и манифест
    res_zip = os.path.join(OUT, 'res.zip')
    run(tool('aapt2'), 'compile', '--dir', os.path.join(src_android, 'res'), '-o', res_zip)
    gen = os.path.join(OUT, 'gen')
    unsigned = os.path.join(OUT, 'unsigned.apk')
    run(tool('aapt2'), 'link', '-o', unsigned, '-I', ANDROID_JAR,
        '--manifest', os.path.join(src_android, 'AndroidManifest.xml'), '-A', os.path.join(OUT, 'assets'),
        '--java', gen, '--min-sdk-version', '26', '--target-sdk-version', '35',
        '--version-code', VERSION_CODE, '--version-name', VERSION_NAME, res_zip)

    # 3) Java → классы → dex
    classes = os.path.join(OUT, 'classes')
    sources = glob.glob(os.path.join(src_android, 'src', '**', '*.java'), recursive=True) + \
        glob.glob(os.path.join(gen, '**', '*.java'), recursive=True)
    run(jdk('javac'), '--release', '17', '-encoding', 'UTF-8', '-classpath', ANDROID_JAR, '-d', classes, *sources)
    dex_dir = os.path.join(OUT, 'dex')
    os.makedirs(dex_dir)
    run(tool('d8'), '--release', '--min-api', '26', '--lib', ANDROID_JAR, '--output', dex_dir,
        *glob.glob(os.path.join(classes, '**', '*.class'), recursive=True))
    with zipfile.ZipFile(unsigned, 'a', zipfile.ZIP_DEFLATED) as z:
        z.write(os.path.join(dex_dir, 'classes.dex'), 'classes.dex')

    # 4) выравнивание и подпись
    aligned = os.path.join(OUT, 'aligned.apk')
    run(tool('zipalign'), '-p', '-f', '4', unsigned, aligned)
    if not os.path.exists(KEYSTORE):
        os.makedirs(os.path.dirname(KEYSTORE), exist_ok=True)
        run(jdk('keytool'), '-genkeypair', '-keystore', KEYSTORE, '-storepass', 'webtabs', '-keypass', 'webtabs',
            '-alias', 'web-tabs', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
            '-dname', 'CN=web-tabs')
        print('создан ключ подписи:', KEYSTORE)
    signed = os.path.join(OUT, 'web-tabs.apk')
    run(tool('apksigner'), 'sign', '--ks', KEYSTORE, '--ks-pass', 'pass:webtabs', '--key-pass', 'pass:webtabs',
        '--out', signed, aligned)
    os.makedirs(DIST, exist_ok=True)
    apk = os.path.join(DIST, 'web-tabs.apk')
    shutil.copy(signed, apk)
    print('готово:', apk, f'{os.path.getsize(apk) // 1024} КБ')

    if 'install' in sys.argv:
        adb = os.path.join(SDK, 'platform-tools', 'adb' + ('.exe' if os.name == 'nt' else ''))
        print(run(adb, 'install', '-r', apk).strip())


if __name__ == '__main__':
    main()
