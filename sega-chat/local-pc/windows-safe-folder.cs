// Экспериментальная Windows-граница для чтения. НЕ подключена к обычному запуску.
// До компиляции, проверки на Windows 10 и независимого аудита не использовать
// на настоящих файлах. Здесь НЕТ записи, переименования или удаления.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

public static class SegaLocalGuard {
    const uint READ_ATTRIBUTES = 0x80, GENERIC_READ = 0x80000000;
    const uint SHARE_READ = 1, SHARE_WRITE = 2; // намеренно НЕТ FILE_SHARE_DELETE
    const uint OPEN_EXISTING = 3, BACKUP_SEMANTICS = 0x02000000, OPEN_REPARSE = 0x00200000;
    const uint DIRECTORY = 0x10, REPARSE = 0x400;
    const int MAX_ENTRIES = 5000, MAX_CHUNK = 128 * 1024, MAX_HASH_FILE = 8 * 1024 * 1024;
    const long MAX_SAFE = 9007199254740991L;

    [StructLayout(LayoutKind.Sequential)]
    public struct FILETIME { public uint low, high; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INFO {
        public uint attributes; public FILETIME created, accessed, modified;
        public uint volume, sizeHigh, sizeLow, links, indexHigh, indexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out INFO info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint size, uint flags);

    public sealed class IdentityResult { public string root; public string dev; public string ino; }
    public sealed class Entry { public string name; public bool dir; public long size; public string modified; }
    public sealed class ListResult { public Entry[] items; }
    public sealed class ReadResult { public string data; public long size; public string modified; public string version; }
    public sealed class HashResult { public string hash; public long size; public string modified; public string version; }

    static INFO Info(SafeFileHandle h) {
        INFO value;
        if (!GetFileInformationByHandle(h, out value)) throw new IOException("Не удалось проверить файл");
        return value;
    }
    static SafeFileHandle Open(string p, bool data, bool directory) {
        // Нет разрешения на удаление/переименование ни одного открытого предка;
        // при чтении файла не разрешаем и параллельную запись.
        SafeFileHandle h = CreateFileW(p, data ? GENERIC_READ : READ_ATTRIBUTES,
            data ? SHARE_READ : SHARE_READ | SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING,
            OPEN_REPARSE | (directory ? BACKUP_SEMANTICS : 0), IntPtr.Zero);
        if (h.IsInvalid) { h.Dispose(); throw new IOException("Файл или папка недоступны"); }
        try {
            INFO i=Info(h);
            // Жёсткая ссылка может вести к файлу за выбранной папкой, хотя
            // конечный путь дескриптора выглядит внутренним. Консервативно
            // отказываем всем файлам с несколькими именами.
            if ((i.attributes & REPARSE) != 0 || (((i.attributes & DIRECTORY) != 0) != directory) || (!directory && i.links != 1)) throw new IOException("Ссылка или неверный тип");
            return h;
        } catch { h.Dispose(); throw; }
    }
    static string FinalPath(SafeFileHandle h) {
        StringBuilder b=new StringBuilder(32768);
        uint n=GetFinalPathNameByHandleW(h,b,(uint)b.Capacity,0);
        if(n==0 || n>=b.Capacity) throw new IOException("Не удалось проверить путь");
        return b.ToString().TrimEnd('\\');
    }
    static string Id(INFO i) { return (((ulong)i.indexHigh << 32) | i.indexLow).ToString(); }
    static string Size(INFO i) {
        ulong n=((ulong)i.sizeHigh << 32) | i.sizeLow;
        if(n > (ulong)MAX_SAFE) throw new IOException("Файл слишком большой");
        return n.ToString();
    }
    static long Length(INFO i) { return long.Parse(Size(i), System.Globalization.CultureInfo.InvariantCulture); }
    static string Date(INFO i) {
        long ft=unchecked((long)(((ulong)i.modified.high << 32) | i.modified.low));
        try { return DateTime.FromFileTimeUtc(ft).ToString("o"); } catch { return ""; }
    }
    static string Version(INFO i) {
        string text=i.volume+":"+Id(i)+":"+Size(i)+":"+i.modified.high+":"+i.modified.low;
        using (SHA256 sha=SHA256.Create()) {
            byte[] hash=sha.ComputeHash(Encoding.UTF8.GetBytes(text));
            StringBuilder b=new StringBuilder(hash.Length*2);
            foreach(byte v in hash)b.Append(v.ToString("x2"));
            return b.ToString();
        }
    }
    static bool SafePart(string s) {
        if (String.IsNullOrEmpty(s) || s.Length>255 || s=="." || s==".." || s.EndsWith(".") || s.EndsWith(" ")) return false;
        foreach(char c in s) if(c<32 || c==127 || "\\/:*?\"<>|".IndexOf(c)>=0) return false;
        return !Regex.IsMatch(s,@"^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$",RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    }
    static string[] Parts(string p) {
        if (p==null || p.Length>4096) throw new IOException("Неверный путь");
        if (p.Length==0) return new string[0];
        string[] all=p.Split('/'); foreach(string s in all) if(!SafePart(s))throw new IOException("Неверный путь");
        return all;
    }
    static string Root(string p) {
        if (String.IsNullOrEmpty(p) || p.Length>4096 || !Regex.IsMatch(p,@"^[A-Za-z]:\\")) throw new IOException("Нужна локальная папка");
        string full=Path.GetFullPath(p).TrimEnd('\\');
        if (full.Length<=2) throw new IOException("Выберите папку, не весь диск");
        string[] parts=full.Substring(3).Split('\\'); foreach(string x in parts)if(!SafePart(x))throw new IOException("Неверный путь");
        return full;
    }
    sealed class Chain : IDisposable {
        readonly List<SafeFileHandle> handles=new List<SafeFileHandle>();
        public string RootPath, RootFinal, Current;
        public INFO RootInfo;
        void AddDirectory(string p) {
            SafeFileHandle h=Open(p,false,true);
            try {
                string real=FinalPath(h), expected=@"\\?\"+p.TrimEnd('\\');
                if (!String.Equals(real,expected,StringComparison.OrdinalIgnoreCase)) throw new IOException("Переход за пределы папки");
                handles.Add(h); Current=p;
            } catch {h.Dispose();throw;}
        }
        public Chain(string root, string dev, string ino, string[] childDirs) {
            try {
                RootPath=Root(root);
                string drive=Path.GetPathRoot(RootPath);
                AddDirectory(drive);
                string p=drive.TrimEnd('\\');
                foreach(string part in RootPath.Substring(drive.Length).Split('\\')) {p += "\\"+part;AddDirectory(p);}
                RootInfo=Info(handles[handles.Count-1]);
                RootFinal=FinalPath(handles[handles.Count-1]);
                if (Id(RootInfo)=="0")throw new IOException("Нельзя проверить папку");
                if(dev!=null && (RootInfo.volume.ToString()!=dev || Id(RootInfo)!=ino))throw new IOException("Папка изменилась");
                foreach(string part in childDirs) {p += "\\"+part;AddDirectory(p);}
            } catch {Dispose();throw;}
        }
        public void Dispose() {for(int i=handles.Count-1;i>=0;i--)handles[i].Dispose();handles.Clear();}
        public void CheckLeaf(SafeFileHandle file, string expected) {
            string actual=FinalPath(file);
            if(!String.Equals(actual,@"\\?\"+expected.TrimEnd('\\'),StringComparison.OrdinalIgnoreCase)
                || !actual.StartsWith(RootFinal+"\\",StringComparison.OrdinalIgnoreCase)) throw new IOException("Переход за пределы папки");
        }
    }
    public static IdentityResult Identify(string root) {
        using(Chain c=new Chain(root,null,null,new string[0])) return new IdentityResult {root=c.RootPath, dev=c.RootInfo.volume.ToString(), ino=Id(c.RootInfo)};
    }
    // Даже строгий вариант не является атомарным снимком: он лишь не
    // пропускает заведомо неподдерживаемые/недоступные элементы. Его нельзя
    // передавать как полное состояние для удаления или синхронизации.
    public static ListResult List(string root,string dev,string ino,string relative) {
        return ListCore(root,dev,ino,relative,false);
    }
    public static ListResult ListFailOnSkipped(string root,string dev,string ino,string relative) {
        return ListCore(root,dev,ino,relative,true);
    }
    static ListResult ListCore(string root,string dev,string ino,string relative,bool failOnSkipped) {
        if(dev==null || ino==null || !Regex.IsMatch(dev,@"^\d+$") || !Regex.IsMatch(ino,@"^[1-9]\d*$"))throw new IOException("Неверная папка");
        string[] pieces=Parts(relative);
        using(Chain c=new Chain(root,dev,ino,pieces)) {
            List<Entry> list=new List<Entry>(); int seen=0;
            foreach(string p in Directory.EnumerateFileSystemEntries(c.Current)) {
                if(++seen>MAX_ENTRIES)throw new IOException("Слишком много файлов");
                string name=Path.GetFileName(p);
                if(!SafePart(name)) {
                    if(failOnSkipped)throw new IOException("Не удалось проверить все элементы папки");
                    continue;
                }
                try {
                    // OPEN_REPARSE_POINT не следует по символической ссылке.
                    // Тип сначала выбираем только для необходимого флага открытия;
                    // конечную проверку выполняет открытый дескриптор.
                    FileAttributes attrs=File.GetAttributes(p);
                    if((attrs & FileAttributes.ReparsePoint)!=0) {
                        if(failOnSkipped)throw new IOException("Не удалось проверить все элементы папки");
                        continue;
                    }
                    bool dir=(attrs & FileAttributes.Directory)!=0;
                    using(SafeFileHandle h=Open(p,false,dir)) {
                        c.CheckLeaf(h,p); INFO i=Info(h);
                        list.Add(new Entry{name=name,dir=dir,size=dir?0:Length(i),modified=Date(i)});
                    }
                } catch(IOException) {if(failOnSkipped)throw;continue;} catch(UnauthorizedAccessException) {if(failOnSkipped)throw;continue;}
            }
            return new ListResult{items=list.ToArray()};
        }
    }
    // Эксперимент: одно открытие на весь расчёт с запретом обычных
    // параллельных открытий для записи/удаления. Это НЕ атомарный снимок:
    // отображения в память, особенности ФС, доверие пути и гонки не доказаны.
    // Нужны компиляция, проверка на Windows 10 и независимый аудит.
    public static HashResult HashLocked(string root,string dev,string ino,string relative) {
        if(dev==null || ino==null || !Regex.IsMatch(dev,@"^\d+$") || !Regex.IsMatch(ino,@"^[1-9]\d*$"))throw new IOException("Неверная папка");
        string[] parts=Parts(relative);
        if(parts.Length==0)throw new IOException("Неверный запрос");
        string[] dirs=new string[parts.Length-1]; Array.Copy(parts,dirs,dirs.Length);
        using(Chain c=new Chain(root,dev,ino,dirs)) {
            string p=c.Current+"\\"+parts[parts.Length-1];
            using(SafeFileHandle h=Open(p,true,false)) {
                c.CheckLeaf(h,p);
                INFO before=Info(h); long size=Length(before); string version=Version(before);
                if(size>MAX_HASH_FILE)throw new IOException("Файл слишком большой");
                byte[] buf=new byte[(int)size]; int read=0;
                using(FileStream stream=new FileStream(h,FileAccess.Read,4096,false)) {
                    while(read<buf.Length) {int n=stream.Read(buf,read,buf.Length-read);if(n<=0)break;read+=n;}
                    if(read!=buf.Length)throw new IOException("Не удалось прочитать файл целиком");
                    string hash;
                    using(SHA256 sha=SHA256.Create()) {
                        byte[] digest=sha.ComputeHash(buf); StringBuilder text=new StringBuilder(digest.Length*2);
                        foreach(byte v in digest)text.Append(v.ToString("x2"));
                        hash=text.ToString();
                    }
                    INFO after=Info(h);
                    if(Version(after)!=version)throw new IOException("Файл изменился");
                    return new HashResult{hash=hash,size=size,modified=Date(before),version=version};
                }
            }
        }
    }
    public static ReadResult Read(string root,string dev,string ino,string relative,long offset,int length,string expectedVersion) {
        if(dev==null || ino==null || !Regex.IsMatch(dev,@"^\d+$") || !Regex.IsMatch(ino,@"^[1-9]\d*$"))throw new IOException("Неверная папка");
        string[] parts=Parts(relative);
        if(parts.Length==0 || offset<0 || length<1 || length>MAX_CHUNK || (expectedVersion!=null && !Regex.IsMatch(expectedVersion,@"^[a-f0-9]{64}$")))throw new IOException("Неверный запрос");
        string[] dirs=new string[parts.Length-1]; Array.Copy(parts,dirs,dirs.Length);
        using(Chain c=new Chain(root,dev,ino,dirs)) {
            string p=c.Current+"\\"+parts[parts.Length-1];
            using(SafeFileHandle h=Open(p,true,false)) {
                c.CheckLeaf(h,p);
                INFO before=Info(h); long size=Length(before); string version=Version(before);
                if(expectedVersion!=null && expectedVersion!=version)throw new IOException("Файл изменился");
                int requested=(int)Math.Min((long)length,Math.Max(0L,size-offset));
                byte[] buf=new byte[requested]; int read=0;
                using(FileStream stream=new FileStream(h,FileAccess.Read,4096,false)) {
                    stream.Seek(offset,SeekOrigin.Begin);
                    while(read<requested) {int n=stream.Read(buf,read,requested-read);if(n<=0)break;read+=n;}
                    INFO after=Info(h);
                    if(Version(after)!=version)throw new IOException("Файл изменился");
                }
                if(read!=buf.Length)throw new IOException("Не удалось прочитать файл целиком");
                return new ReadResult{data=Convert.ToBase64String(buf),size=size,modified=Date(before),version=version};
            }
        }
    }
}
