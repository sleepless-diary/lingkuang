import socket, qrcode

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    s.connect(('8.8.8.8', 80))
    ip = s.getsockname()[0]
except Exception:
    ip = socket.gethostbyname(socket.gethostname())
finally:
    s.close()

ip = '192.168.1.102' if ip.startswith('169.254') else ip
url = 'http://%s:7717' % ip
img = qrcode.make(url)
out = r'F:/OpenDesign/.od/projects/lingkuang-v3-ui/tools/kb-viewer/public/icons/qr-lan.png'
img.save(out)
print('URL=' + url)
print('SAVED=' + out)
