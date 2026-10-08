"""Pruebas offline de permisos, sin credenciales ni conexiones externas."""
import ast
import unittest
from pathlib import Path
from datavault.drive_acl import normalize_assignments, parse_drive_folder_link, scoped_chain

ROOT = Path(__file__).with_name('main.py')


class FakeHttpError(Exception):
    def __init__(self, status_code, code, message):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class FakeRequest:
    def __init__(self, value):
        self.value = value

    def execute(self, **kwargs):
        return self.value


class FakeDrive:
    def __init__(self):
        self.meta = {}
        self.children = {}

    def files(self):
        return self

    def get(self, *, fileId, **kwargs):
        if fileId not in self.meta:
            raise ValueError('No existe')
        return FakeRequest(self.meta[fileId])

    def list(self, *, q, **kwargs):
        parent = q.split("'")[1]
        return FakeRequest({'files': self.children.get(parent, [])})


class TestDriveAcl(unittest.TestCase):
    def setUp(self):
        self.a = 'A' * 25
        self.b = 'B' * 25
        self.c = 'C' * 25
        self.child = 'D' * 25
        self.fake = FakeDrive()
        def meta(fid, name, parent):
            return {'id':fid,'name':name,'parents':[parent] if parent else [], 'mimeType':'application/vnd.google-apps.folder'}
        self.fake.meta = {
            self.a:meta(self.a,'Carátulas','physical-root'),
            self.b:meta(self.b,'Compilados','physical-root'),
            self.c:meta(self.c,'Tomos','physical-root'),
            self.child:meta(self.child,'Subcarpeta',self.a),
            'physical-root':meta('physical-root','ROOT',None),
        }
        self.fake.children={'physical-root':[self.fake.meta[x] for x in (self.a,self.b,self.c)],self.a:[self.fake.meta[self.child]]}
        # Extraer funciones concretas para evaluarlas con un Drive y una BD simulados,
        # evitando el arranque de servicios de Supabase/Telegram.
        tree=ast.parse(ROOT.read_text())
        names={'_mi_raiz_virtual','resolver_ruta_drive_usuario','validar_destino_usuario','listar_hijos_drive'}
        funcs=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in names]
        env={'dict':dict,'error_api':lambda code,key,msg:FakeHttpError(code,key,msg),
             'obtener_carpetas_autorizadas':lambda _:self.folders,
             'obtener_servicio_google_drive':lambda:self.fake,
             'GOOGLE_API_RETRIES':0,'scoped_chain':scoped_chain,
             'resolver_ruta_drive':lambda _:self.fake.meta['physical-root'],
             'validar_destino_drive':lambda _:self.fake.meta['physical-root'],
             '_cache_drive_get':lambda _:None, '_cache_drive_set':lambda *_:None}
        exec(compile(ast.Module(body=funcs,type_ignores=[]),str(ROOT),'exec'),env)
        self.env=env
        self.folders=[{'id':self.a,'name':'Carátulas'}, {'id':self.b,'name':'Compilados'}]
        self.user={'id':'joel-id','rol':'subordinado'}

    def test_links_maximum_and_duplicates(self):
        link=f'https://drive.google.com/drive/folders/{self.a}?usp=sharing'
        self.assertEqual(parse_drive_folder_link(link),self.a)
        self.assertEqual(len(normalize_assignments([{'url':link}])),1)
        with self.assertRaises(ValueError):
            normalize_assignments([{'url':link}]*2)
        with self.assertRaises(ValueError):
            normalize_assignments([{'url':link+str(i)} for i in range(6)])
        with self.assertRaises(ValueError):
            parse_drive_folder_link('https://example.com/drive/folders/'+self.a)
        with self.assertRaises(ValueError):
            parse_drive_folder_link('https://drive.google.com/file/d/'+self.a+'/view')

    def test_virtual_root_shows_only_two_folders(self):
        view=self.env['listar_hijos_drive']('root',usuario=self.user)
        self.assertEqual(view['current']['name'],'Mis carpetas')
        self.assertFalse(view['current']['selectable'])
        self.assertEqual({f['id'] for f in view['folders']},{self.a,self.b})
        self.assertNotIn(self.c,{f['id'] for f in view['folders']})
        self.assertEqual(view['files'],[])

    def test_descendants_allowed_but_root_and_other_folders_forbidden(self):
        resolve=self.env['validar_destino_usuario']
        valid=resolve(self.child,self.user)
        self.assertEqual(valid['breadcrumb'][0]['id'],'root')
        self.assertEqual([x['id'] for x in valid['breadcrumb'][1:]],[self.a,self.child])
        self.assertNotIn('physical-root',str(valid))
        for id_ in ('root','physical-root',self.c):
            with self.assertRaises(FakeHttpError) as exc:
                resolve(id_,self.user)
            self.assertEqual(exc.exception.status_code,403)

    def test_revoked_access_immediate(self):
        self.folders=[{'id':self.b,'name':'Compilados'}]
        with self.assertRaises(FakeHttpError):
            self.env['resolver_ruta_drive_usuario'](self.child,self.user)
        view=self.env['listar_hijos_drive']('root',usuario=self.user)
        self.assertEqual([f['id'] for f in view['folders']],[self.b])

    def test_empty_acl_is_fail_closed(self):
        self.folders=[]
        self.assertEqual(self.env['listar_hijos_drive']('root',usuario=self.user)['folders'],[])
        with self.assertRaises(FakeHttpError):
            self.env['validar_destino_usuario'](self.a,self.user)

    def test_admin_still_uses_real_root(self):
        admin={'id':'admin','rol':'jefe'}
        self.assertEqual(self.env['resolver_ruta_drive_usuario']('root',admin)['id'],'physical-root')


if __name__ == '__main__':
    unittest.main(verbosity=2)
